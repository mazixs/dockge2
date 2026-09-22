package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"syscall"
)

// readRegular refuses symlink metadata and bounds allocations before reading it.
func readRegular(path string, limit int64) ([]byte, error) {
	f, err := os.OpenFile(path, os.O_RDONLY|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() || info.Size() > limit {
		return nil, fmt.Errorf("not a bounded regular file: %s", path)
	}
	data, err := io.ReadAll(io.LimitReader(f, limit+1))
	if int64(len(data)) > limit {
		return nil, errors.New("file grew while reading")
	}
	return data, err
}
func syncDir(path string) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	return f.Sync()
}
func atomicWrite(path string, data []byte, mode os.FileMode) error {
	if info, err := os.Lstat(path); err == nil && !info.Mode().IsRegular() {
		return errors.New("refusing non-regular destination")
	}
	f, err := os.CreateTemp(filepath.Dir(path), ".pending-")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	if err = f.Chmod(mode); err == nil {
		_, err = f.Write(data)
	}
	if err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	if err = os.Rename(f.Name(), path); err != nil {
		return err
	}
	return syncDir(filepath.Dir(path))
}
func writeJSON(path string, value any) error {
	data, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return err
	}
	return atomicWrite(path, append(data, '\n'), 0600)
}
func privateDir(path string) error {
	if err := os.MkdirAll(path, 0700); err != nil {
		return err
	}
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if !info.IsDir() || info.Mode().Perm()&0077 != 0 {
		return fmt.Errorf("state directory must be private (0700), not a symlink: %s", path)
	}
	return nil
}

// canonicalPath resolves existing parents without creating a prospective directory.
func canonicalPath(path string) (string, error) {
	abs, err := filepath.Abs(path)
	if err != nil {
		return "", err
	}
	current := abs
	tail := []string{}
	for {
		_, err = os.Lstat(current)
		if err == nil {
			break
		}
		if !os.IsNotExist(err) {
			return "", err
		}
		parent := filepath.Dir(current)
		if parent == current {
			return "", err
		}
		tail = append(tail, filepath.Base(current))
		current = parent
	}
	current, err = filepath.EvalSymlinks(current)
	if err != nil {
		return "", err
	}
	for i := len(tail) - 1; i >= 0; i-- {
		current = filepath.Join(current, tail[i])
	}
	return current, nil
}

func within(parent, child string) bool {
	rel, err := filepath.Rel(parent, child)
	return err == nil && rel != ".." && !filepath.IsAbs(rel) && (len(rel) < 3 || rel[:3] != "../")
}

// lockProject is shared across entry points and installation directories on this host.
// Local Unix Docker endpoints only: a host file lock cannot serialize remote hosts.
func lockProject(daemon, project string) (*os.File, error) {
	key := fileHash([]byte(daemon + "\n" + project))
	path := filepath.Join("/tmp", "dockge2-update-"+key+".lock")
	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR|syscall.O_NOFOLLOW, 0600)
	if err != nil {
		return nil, err
	}
	info, err := f.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0077 != 0 {
		f.Close()
		return nil, errors.New("unsafe update lock")
	}
	if err = syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		f.Close()
		return nil, errors.New("another update owns this Docker project")
	}
	return f, nil // Never unlink: an old inode must not create two independent locks.
}

// copyTree snapshots stopped application data and rejects symlinks/devices.
// Every copied file is flushed and its bytes checked before the snapshot is accepted.
func copyTree(source, dest string) error { return copyTreeContext(context.Background(), source, dest) }

type cancellableReader struct {
	ctx    context.Context
	reader io.Reader
}

func (r cancellableReader) Read(p []byte) (int, error) {
	if err := r.ctx.Err(); err != nil {
		return 0, err
	}
	return r.reader.Read(p)
}

func copyTreeContext(ctx context.Context, source, dest string) error {
	if within(source, dest) || within(dest, source) {
		return errors.New("snapshot and data paths must be disjoint")
	}
	dirs := []struct {
		path string
		info os.FileInfo
	}{}
	err := filepath.WalkDir(source, func(path string, entry os.DirEntry, walkErr error) error {
		if err := ctx.Err(); err != nil {
			return err
		}
		if walkErr != nil {
			return walkErr
		}
		rel, err := filepath.Rel(source, path)
		if err != nil {
			return err
		}
		target := filepath.Join(dest, rel)
		info, err := entry.Info()
		if err != nil {
			return err
		}
		if entry.IsDir() {
			dirs = append(dirs, struct {
				path string
				info os.FileInfo
			}{target, info})
			return os.MkdirAll(target, 0700)
		}
		if !info.Mode().IsRegular() {
			return fmt.Errorf("data snapshot refuses non-regular file: %s", rel)
		}
		in, err := os.OpenFile(path, os.O_RDONLY|syscall.O_NOFOLLOW, 0)
		if err != nil {
			return err
		}
		defer in.Close()
		out, err := os.OpenFile(target, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
		if err != nil {
			return err
		}
		h := sha256.New()
		_, err = io.Copy(io.MultiWriter(out, h), cancellableReader{ctx: ctx, reader: in})
		if err == nil {
			err = out.Sync()
		}
		closeErr := out.Close()
		if err == nil {
			err = closeErr
		}
		if err != nil {
			return err
		}
		check, err := os.Open(target)
		if err != nil {
			return err
		}
		hc := sha256.New()
		_, err = io.Copy(hc, check)
		check.Close()
		if err != nil {
			return err
		}
		if hex.EncodeToString(h.Sum(nil)) != hex.EncodeToString(hc.Sum(nil)) {
			return errors.New("snapshot verification failed")
		}
		if stat, ok := info.Sys().(*syscall.Stat_t); ok {
			if err = os.Chown(target, int(stat.Uid), int(stat.Gid)); err != nil {
				return err
			}
		}
		return os.Chmod(target, info.Mode().Perm()&0770)
	})
	if err != nil {
		return err
	}
	for i := len(dirs) - 1; i >= 0; i-- {
		d := dirs[i]
		if stat, ok := d.info.Sys().(*syscall.Stat_t); ok {
			if err = os.Chown(d.path, int(stat.Uid), int(stat.Gid)); err != nil {
				return err
			}
		}
		if err = os.Chmod(d.path, d.info.Mode().Perm()&0770); err != nil {
			return err
		}
		if err = syncDir(d.path); err != nil {
			return err
		}
	}
	return syncDir(filepath.Dir(dest))
}

// atomicCopy keeps verifier installation bounded in memory (the verifier is large).
func atomicCopy(source, dest string, mode os.FileMode, limit int64) error {
	in, err := os.OpenFile(source, os.O_RDONLY|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return err
	}
	defer in.Close()
	info, err := in.Stat()
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() || info.Size() > limit {
		return errors.New("invalid executable source")
	}
	if info, err := os.Lstat(dest); err == nil && !info.Mode().IsRegular() {
		return errors.New("invalid executable destination")
	}
	out, err := os.CreateTemp(filepath.Dir(dest), ".executable-")
	if err != nil {
		return err
	}
	defer os.Remove(out.Name())
	if err = out.Chmod(mode); err != nil {
		out.Close()
		return err
	}
	n, err := io.Copy(out, io.LimitReader(in, limit+1))
	if err == nil && n != info.Size() {
		err = errors.New("executable changed while copying")
	}
	if err == nil {
		err = out.Sync()
	}
	closeErr := out.Close()
	if err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	if err = os.Rename(out.Name(), dest); err != nil {
		return err
	}
	return syncDir(filepath.Dir(dest))
}

// checkBackupSpace catches the ordinary disk-full case before stopping writers.
// Concurrent host writes can still exhaust space; the recovery path removes only
// this operation's incomplete snapshot before trying to restart the previous panel.
func checkBackupSpace(data, state string) error {
	var bytes uint64
	err := filepath.WalkDir(data, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		if entry.IsDir() {
			bytes += 4096
			return nil
		}
		if !info.Mode().IsRegular() {
			return errors.New("data contains a non-regular file; backup cannot proceed")
		}
		bytes += uint64(info.Size())
		return nil
	})
	if err != nil {
		return err
	}
	var disk syscall.Statfs_t
	if err = syscall.Statfs(state, &disk); err != nil {
		return err
	}
	required := bytes + bytes/20 + (64 << 20)
	if uint64(disk.Bavail)*uint64(disk.Bsize) < required {
		return errors.New("insufficient free space for a data snapshot and recovery headroom")
	}
	return nil
}
