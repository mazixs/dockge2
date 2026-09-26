package main

import (
	"context"
	"debug/elf"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

// internalRestoreFlag starts the entrypoint of the restore container. It is not an option
// of the updater: it is not in the flag set and only matches as the first argument, which
// the installed launcher never passes.
const internalRestoreFlag = "--dockge2-internal-restore"

var operationID = regexp.MustCompile(`^[0-9]{8}T[0-9]{6}\.[0-9]{9}$`)

func failedDataDir(data, id string) string { return data + ".dockge-failed-" + id }

// validateRestore accepts only the layout the updater creates: the snapshot of operation id
// under <dir>/.dockge2/operations, and a canonical data directory outside that state whose
// parent can be mounted into a container.
func validateRestore(data, snapshot, id string) error {
	if !operationID.MatchString(id) {
		return errors.New("invalid operation id")
	}
	for _, p := range []string{data, snapshot} {
		// Commas and quotes would change the meaning of a --mount specification.
		if !filepath.IsAbs(p) || filepath.Clean(p) != p || strings.ContainsAny(p, ",\"\r\n") {
			return errors.New("restore paths must be clean absolute paths")
		}
	}
	parent := filepath.Dir(data)
	if parent == "/" || data == "/" {
		return errors.New("a data directory directly under / cannot be restored in a container; restore it manually from the snapshot")
	}
	operationDir := filepath.Dir(snapshot)
	state := filepath.Dir(filepath.Dir(operationDir))
	if filepath.Base(snapshot) != "data-backup" || filepath.Base(operationDir) != id || filepath.Base(filepath.Dir(operationDir)) != "operations" || filepath.Base(state) != ".dockge2" {
		return errors.New("snapshot is not the backup of the recorded operation")
	}
	if within(data, state) || within(state, data) {
		return errors.New("data and updater state must be disjoint")
	}
	// Between the two renames the data directory does not exist; its parent always does.
	check := data
	if !exists(data) {
		check = parent
	}
	if canonical, err := filepath.EvalSymlinks(check); err != nil || canonical != check {
		return errors.New("data path must be canonical, without symlinks")
	}
	return nil
}

// restoreData replaces the data directory with a copy of the verified snapshot and keeps
// the data it replaces beside it. Both stay on the data filesystem, and the markers make a
// run that was interrupted between the renames safe to repeat without overwriting newer data.
func restoreData(ctx context.Context, data, snapshot, id string) error {
	if err := validateRestore(data, snapshot, id); err != nil {
		return err
	}
	if err := verifySnapshot(snapshot); err != nil {
		return err
	}
	staged := data + ".dockge-restore-" + id
	failed := failedDataDir(data, id)
	if !exists(failed) {
		if exists(staged) {
			if err := os.RemoveAll(staged); err != nil {
				return err
			}
		}
		if err := copyTreeContext(ctx, snapshot, staged); err != nil {
			return err
		}
		if err := os.Rename(data, failed); err != nil {
			return err
		}
		if err := syncDir(filepath.Dir(data)); err != nil {
			return err
		}
	}
	if !exists(data) {
		if err := os.Rename(staged, data); err != nil {
			return err
		}
		if err := syncDir(filepath.Dir(data)); err != nil {
			return err
		}
	}
	return nil
}

// internalRestore is the entrypoint of the restore container, where it runs as PID 1.
func internalRestore(ctx context.Context, args []string, stderr io.Writer) int {
	if len(args) != 3 || os.Getpid() != 1 {
		fmt.Fprintln(stderr, "the data restore runs only as the entrypoint of its own container")
		return 2
	}
	if err := restoreData(ctx, args[0], args[1], args[2]); err != nil {
		fmt.Fprintln(stderr, redact(err.Error()))
		return 1
	}
	return 0
}

// restoreSnapshot runs restoreData in a container of the previous image. The data
// directory's parent is its only writable mount, so an updater that sees the data read-only,
// like the panel's update helper, can still restore it. The fixed name refuses a second
// restore of the same operation while one runs.
func (d docker) restoreSnapshot(ctx context.Context, image, binary, data, snapshot, id string) error {
	if err := validateRestore(data, snapshot, id); err != nil {
		return err
	}
	parent := filepath.Dir(data)
	return d.runAttended(ctx, "dockge2-restore-"+d.project+"-"+id,
		"--network", "none", "--read-only", "--user", "0:0", "--security-opt", "no-new-privileges",
		"--cap-drop", "ALL", "--cap-add", "CHOWN", "--cap-add", "DAC_OVERRIDE", "--cap-add", "FOWNER",
		"--mount", "type=bind,src="+parent+",dst="+parent,
		"--mount", "type=bind,src="+snapshot+",dst="+snapshot+",readonly",
		"--mount", "type=bind,src="+snapshot+".sha256.json,dst="+snapshot+".sha256.json,readonly",
		"--mount", "type=bind,src="+binary+",dst=/dockge2-updater,readonly",
		"--entrypoint", "/dockge2-updater", image, internalRestoreFlag, data, snapshot, id)
}

// errRestoreRunning means a restore container may still write into the data directory: the
// journal stays on its running phase and the operator waits for it before the next restore.
var errRestoreRunning = errors.New("the data restore container may still be running")

// runAttended runs a --rm container and waits for it. When the run fails, or its context ends
// and only the docker client is killed, the container itself belongs to the daemon and would
// go on writing: it is removed by name, unless the name was taken by another run.
func (d docker) runAttended(ctx context.Context, name string, args ...string) error {
	_, err := d.command(ctx, append([]string{"run", "--rm", "--name", name}, args...)...)
	if err == nil || daemonSays(err, "is already in use by container") {
		return err
	}
	if stopErr := d.stopContainer(ctx, name); stopErr != nil {
		return fmt.Errorf("%w: %s after %w; stopping it failed: %w; wait until it has exited, then use --rollback --restore-data", errRestoreRunning, name, err, stopErr)
	}
	return err
}

// stopContainer kills and removes a container on its own deadline, since the caller's may have
// passed. A container that is gone, or that the daemon already removes after its exit, is stopped.
func (d docker) stopContainer(ctx context.Context, name string) error {
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), time.Minute)
	defer cancel()
	_, err := d.command(ctx, "rm", "--force", name)
	if err == nil || daemonSays(err, "no such container") {
		return nil
	}
	if !daemonSays(err, "already in progress") {
		return err
	}
	if _, err = d.command(ctx, "wait", name); err != nil && !daemonSays(err, "no such container") {
		return err
	}
	return nil
}

// daemonSays matches the daemon's own words in the stderr of a failed docker command.
func daemonSays(err error, text string) bool {
	var c *commandError
	return errors.As(err, &c) && strings.Contains(strings.ToLower(c.detail), text)
}

// staticBinary refuses an executable that needs a dynamic loader: the previous image runs it
// and supplies none. Release builds are static (CGO_ENABLED=0).
func staticBinary(path string) error {
	f, err := elf.Open(path)
	if err != nil {
		return fmt.Errorf("the updater binary is not a readable executable: %w", err)
	}
	defer f.Close()
	for _, p := range f.Progs {
		if p.Type == elf.PT_INTERP {
			return errors.New("the updater binary is dynamically linked; the data restore needs the static release build")
		}
	}
	return nil
}

// updaterBinary is the running executable, mounted into the restore container.
func (e *engine) updaterBinary() (string, error) {
	if e.binary != nil {
		return e.binary()
	}
	path, err := os.Executable()
	if err == nil {
		path, err = filepath.EvalSymlinks(path)
	}
	if err != nil {
		return "", err
	}
	if strings.ContainsAny(path, ",\"\r\n") {
		return "", errors.New("the updater binary path cannot be mounted")
	}
	return path, staticBinary(path)
}

// checkRestore establishes, before anything changes, that the snapshot can replace the data.
func (e *engine) checkRestore(ctx context.Context, d docker, state string, op operation) (string, error) {
	if !op.BackupVerified || !within(state, op.Backup) {
		return "", errors.New("no verified data snapshot")
	}
	if err := validateRestore(op.Previous.DataDir, op.Backup, op.ID); err != nil {
		return "", err
	}
	if err := verifySnapshot(op.Backup); err != nil {
		return "", err
	}
	if err := d.checkSnapshot(ctx, op.Previous.ImageID, op.Backup); err != nil {
		return "", err
	}
	return e.updaterBinary()
}
