package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

type fakeRunner struct {
	call  func(string, []string) ([]byte, error)
	calls []string
}

func (f *fakeRunner) run(_ context.Context, c string, a ...string) ([]byte, error) {
	f.calls = append(f.calls, c+" "+strings.Join(a, " "))
	if f.call != nil {
		return f.call(c, a)
	}
	return nil, nil
}
func fixture(t *testing.T) (Release, string) {
	t.Helper()
	dir := t.TempDir()
	r := Release{Format: 1, Version: "0.0.9", Commit: strings.Repeat("a", 40), Channel: "stable", Image: "ghcr.io/mazixs/dockge2", Digest: "sha256:" + strings.Repeat("b", 64), Platforms: map[string]string{"linux/amd64": "sha256:" + strings.Repeat("c", 64), "linux/arm64": "sha256:" + strings.Repeat("d", 64)}, Assets: map[string]Asset{}, MinUpdater: 1, MinCompose: "2.20.0", MinEngine: "24.0.0", MinVersion: "0.0.8", Schema: strings.Repeat("e", 64)}
	for _, n := range []string{"docker-compose.yml", "install.sh", "dockge2-update-linux-amd64", "dockge2-update-linux-arm64"} {
		b := []byte(n)
		r.Assets[n] = Asset{fileHash(b), int64(len(b))}
		must(t, atomicWrite(filepath.Join(dir, n), b, 0600))
	}
	must(t, writeJSON(filepath.Join(dir, "release.json"), r))
	must(t, atomicWrite(filepath.Join(dir, "release.json.sigstore.json"), []byte("test bundle"), 0600))
	return r, dir
}
func must(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}
func TestReleaseContract(t *testing.T) {
	r, _ := fixture(t)
	cases := map[string]func(*Release){"version": func(r *Release) { r.Version = "0.1.0" }, "commit": func(r *Release) { r.Commit = "main" }, "tag digest": func(r *Release) { r.Digest = "latest" }, "missing arm": func(r *Release) { delete(r.Platforms, "linux/arm64") }, "extra asset": func(r *Release) { r.Assets["../exec.sh"] = Asset{strings.Repeat("a", 64), 1} }, "new protocol": func(r *Release) { r.MinUpdater = 2 }, "missing hash": func(r *Release) { r.Assets["install.sh"] = Asset{} }, "wrong channel": func(r *Release) { r.Channel = "prerelease" }}
	b, _ := json.Marshal(r)
	_, err := parseRelease(b, r.Version)
	must(t, err)
	for name, change := range cases {
		t.Run(name, func(t *testing.T) {
			var x Release
			must(t, json.Unmarshal(b, &x))
			change(&x)
			data, _ := json.Marshal(x)
			if _, err := parseRelease(data, r.Version); err == nil {
				t.Fatal("unsafe contract accepted")
			}
		})
	}
	if _, err := parseRelease(append(b, []byte("{}")...), r.Version); err == nil {
		t.Fatal("trailing document accepted")
	}
}
func TestStageAuthenticatesBeforeAssets(t *testing.T) {
	r, source := fixture(t)
	run := &fakeRunner{}
	c := newReleaseClient(run, "cosign")
	_, err := c.stage(context.Background(), r.Version, source, filepath.Join(t.TempDir(), "stage"))
	must(t, err)
	if len(run.calls) != 1 || !strings.Contains(run.calls[0], "release.yml@refs/tags/v0.0.9") || !strings.Contains(run.calls[0], "--certificate-oidc-issuer https://token.actions.githubusercontent.com") {
		t.Fatal(run.calls)
	}
	run.call = func(string, []string) ([]byte, error) { return nil, errors.New("wrong signer") }
	dest := filepath.Join(t.TempDir(), "stage")
	_, err = c.stage(context.Background(), r.Version, source, dest)
	if err == nil || exists(filepath.Join(dest, "docker-compose.yml")) {
		t.Fatal("signature failure consumed release assets")
	}
	run.call = nil
	must(t, os.WriteFile(filepath.Join(source, "docker-compose.yml"), []byte("broken main"), 0600))
	_, err = c.stage(context.Background(), r.Version, source, filepath.Join(t.TempDir(), "stage"))
	if err == nil {
		t.Fatal("tampered compose accepted")
	}
}

type roundTrip func(*http.Request) (*http.Response, error)

func (f roundTrip) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }
func TestDownloadNeverUsesBranchOrBuild(t *testing.T) {
	r, source := fixture(t)
	run := &fakeRunner{}
	c := newReleaseClient(run, "cosign")
	var urls []string
	c.client.Transport = roundTrip(func(req *http.Request) (*http.Response, error) {
		urls = append(urls, req.URL.String())
		b, err := os.ReadFile(filepath.Join(source, filepath.Base(req.URL.Path)))
		if err != nil {
			return nil, err
		}
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(string(b)))}, nil
	})
	_, err := c.stage(context.Background(), r.Version, "", filepath.Join(t.TempDir(), "stage"))
	must(t, err)
	for _, u := range urls {
		if !strings.HasPrefix(u, "https://github.com/mazixs/dockge2/releases/download/v0.0.9/") {
			t.Fatal(u)
		}
	}
	c.client.Transport = roundTrip(func(*http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: 403, Body: io.NopCloser(strings.NewReader("denied"))}, nil
	})
	_, err = c.stage(context.Background(), r.Version, "", filepath.Join(t.TempDir(), "stage"))
	if err == nil {
		t.Fatal("download failure accepted")
	}
	for _, call := range run.calls {
		if strings.Contains(call, "build") || strings.Contains(call, "git ") {
			t.Fatal(call)
		}
	}
}
func TestSemverAndSources(t *testing.T) {
	for _, pair := range [][2]string{{"1.0.0-rc.2", "1.0.0-rc.10"}, {"1.0.0-rc.10", "1.0.0"}, {"9.0.0", "10.0.0"}, {"1.0.0-1", "1.0.0-a"}} {
		if compareVersion(pair[0], pair[1]) >= 0 {
			t.Fatal(pair)
		}
	}
	for _, v := range []string{"mirror.example/team/panel:0.0.9", "ghcr.io/mazixs/dockge2:latest"} {
		_, err := selectedVersion("", v)
		must(t, err)
	}
	if _, err := selectedVersion("", "ghcr.io/mazixs/dockge2@sha256:bad"); err == nil {
		t.Fatal("digest without descriptor version accepted")
	}
	if _, err := arguments([]string{"--build"}); err == nil {
		t.Fatal("old implicit build accepted")
	}
	if _, err := arguments([]string{"--restore-data"}); err == nil {
		t.Fatal("implicit data restoration")
	}
}
func TestRecoveryArgumentsCannotSilentlySelectAnotherOperation(t *testing.T) {
	for _, args := range [][]string{
		{"--resume", "--version", "1.2.3"},
		{"--resume", "--image", "ghcr.io/mazixs/dockge2:latest"},
		{"--status", "--rollback"},
		{"--status", "--resume"},
	} {
		if _, err := arguments(args); err == nil {
			t.Fatalf("ambiguous recovery accepted: %v", args)
		}
	}
}

func TestAtomicFilesSnapshotsAndLock(t *testing.T) {
	dir := t.TempDir()
	source := filepath.Join(dir, "data")
	must(t, os.Mkdir(source, 0700))
	must(t, atomicWrite(filepath.Join(source, "db-wal"), []byte("committed WAL"), 0600))
	snapshot := filepath.Join(dir, "backup")
	must(t, copyTree(source, snapshot))
	must(t, recordSnapshot(snapshot))
	must(t, verifySnapshot(snapshot))
	must(t, os.WriteFile(filepath.Join(snapshot, "db-wal"), []byte("corrupt"), 0600))
	if verifySnapshot(snapshot) == nil {
		t.Fatal("corrupted backup accepted")
	}
	symlink := filepath.Join(dir, "link")
	must(t, os.Symlink(filepath.Join(source, "db-wal"), symlink))
	if atomicWrite(symlink, []byte("replace"), 0600) == nil {
		t.Fatal("symlink overwritten")
	}
	if _, err := readRegular(symlink, 100); err == nil {
		t.Fatal("symlink metadata read")
	}
	must(t, os.Symlink("db-wal", filepath.Join(source, "link")))
	if copyTree(source, filepath.Join(dir, "bad")) == nil {
		t.Fatal("symlink snapshot accepted")
	}
	lock, err := lockProject("test-"+dir, "panel")
	must(t, err)
	defer lock.Close()
	if second, err := lockProject("test-"+dir, "panel"); err == nil {
		second.Close()
		t.Fatal("second writer admitted")
	}
}
func TestResolvedConfigurationPreservesDollarsAndUsesExplicitFile(t *testing.T) {
	c, err := parseConfig([]byte(`{"name":"panel","services":{"dockge":{"image":"old","build":{"context":"."},"environment":{"SECRET":"cost$5"},"volumes":[{"type":"bind","source":"/srv/panel","target":"/app/data"}]}}}`))
	must(t, err)
	b, err := configSnapshot(c, "repo/panel@sha256:"+strings.Repeat("a", 64))
	must(t, err)
	if !strings.Contains(string(b), "cost$$5") || strings.Contains(string(b), `"build"`) {
		t.Fatal(string(b))
	}
	run := &fakeRunner{}
	d := docker{run: run, dir: "/srv/panel", project: "panel"}
	must(t, d.up(context.Background(), "/srv/panel/.dockge2/target.json"))
	call := run.calls[0]
	for _, s := range []string{"--project-directory /srv/panel", "-p panel", "-f /srv/panel/.dockge2/target.json", "--no-build --pull never --no-deps --wait"} {
		if !strings.Contains(call, s) {
			t.Fatal(call)
		}
	}
}
func TestSchemaChangeRequiresExplicitRestoreBeforeMutation(t *testing.T) {
	dir := t.TempDir()
	state := filepath.Join(dir, ".dockge2")
	must(t, privateDir(state))
	op := operation{ID: "test", Phase: "checking-target", Previous: &installed{Version: "0.0.8", Schema: strings.Repeat("a", 64), ImageID: "sha256:" + strings.Repeat("a", 64), Project: "panel", DataDir: filepath.Join(dir, "data"), Config: filepath.Join(state, "previous.json")}, Target: installed{Version: "0.0.9", Schema: strings.Repeat("b", 64), ImageID: "sha256:" + strings.Repeat("b", 64), Project: "panel", DataDir: filepath.Join(dir, "data"), Config: filepath.Join(state, "target.json")}}
	must(t, writeJSON(filepath.Join(state, "operation.json"), op))
	run := &fakeRunner{call: func(_ string, args []string) ([]byte, error) {
		switch args[0] {
		case "context":
			return []byte("unix:///var/run/docker.sock"), nil
		case "info":
			return []byte("test-" + dir), nil
		case "ps":
			return nil, nil
		}
		t.Fatalf("unexpected mutation: %v", args)
		return nil, nil
	}}
	out, err := os.CreateTemp(t.TempDir(), "log")
	must(t, err)
	defer out.Close()
	e := engine{run: run, out: out}
	err = e.rollback(context.Background(), options{dir: dir, yes: true}, state)
	if err == nil || !strings.Contains(err.Error(), "--restore-data") {
		t.Fatal(err)
	}
	_ = runtime.GOARCH
}

func TestSnapshotCancellationLeavesOriginalData(t *testing.T) {
	dir := t.TempDir()
	source := filepath.Join(dir, "data")
	must(t, os.Mkdir(source, 0700))
	must(t, os.WriteFile(filepath.Join(source, "db"), []byte("keep"), 0600))
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := copyTreeContext(ctx, source, filepath.Join(dir, "backup")); !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	data, err := os.ReadFile(filepath.Join(source, "db"))
	must(t, err)
	if string(data) != "keep" {
		t.Fatal("source changed")
	}
}

func TestCanonicalPathsBeforeCreationAndOtherWriters(t *testing.T) {
	dir := t.TempDir()
	must(t, os.Mkdir(filepath.Join(dir, "real"), 0700))
	must(t, os.Symlink(filepath.Join(dir, "real"), filepath.Join(dir, "alias")))
	path, err := canonicalPath(filepath.Join(dir, "alias", "not-created"))
	must(t, err)
	if path != filepath.Join(dir, "real", "not-created") || exists(path) {
		t.Fatal(path)
	}
	run := &fakeRunner{call: func(_ string, args []string) ([]byte, error) {
		if args[0] == "ps" {
			return []byte("own\nother"), nil
		}
		if args[0] == "inspect" {
			return []byte(`[{"Type":"bind","Source":"/srv/panel","RW":true}]`), nil
		}
		t.Fatal(args)
		return nil, nil
	}}
	d := docker{run: run}
	if d.otherWriters(context.Background(), "own", "/srv/panel/data") == nil {
		t.Fatal("concurrent data writer accepted")
	}
}
