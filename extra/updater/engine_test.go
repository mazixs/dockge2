package main

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// A command-boundary fixture. Docker/SQLite behaviour is additionally exercised
// by test/install/docker.sh; this fixture injects failures at precise journal phases.
type deploymentFixture struct {
	t                                                               *testing.T
	dir, data, state, assets, verifier                              string
	release                                                         Release
	oldID, targetID, image, containerID                             string
	oldVersion, oldCommit, oldDigest                                string
	oldRepoDigests                                                  []string
	running                                                         bool
	pullFailure, startFailure, snapshotFailure, crashAt, crashPhase string
	stops, starts                                                   int
	runner                                                          *fakeRunner
}

func newDeployment(t *testing.T) *deploymentFixture {
	t.Helper()
	r, assets := fixture(t)
	dir := t.TempDir()
	w := &deploymentFixture{t: t, dir: dir, data: filepath.Join(dir, "data"), state: filepath.Join(dir, ".dockge2"), assets: assets, release: r, oldID: "sha256:" + strings.Repeat("1", 64), targetID: "sha256:" + strings.Repeat("2", 64), containerID: "oldcontainer", running: true, oldVersion: "0.0.8"}
	w.image = w.oldID
	must(t, os.Mkdir(w.data, 0700))
	must(t, os.WriteFile(filepath.Join(w.data, "dockge.db"), []byte("old fixture data"), 0600))
	must(t, privateDir(w.state))
	must(t, os.WriteFile(filepath.Join(dir, ".env"), []byte("# operator settings stay byte-identical\n"), 0600))
	oldDir := filepath.Join(w.state, "old")
	must(t, privateDir(oldDir))
	compose := []byte("docker-compose.yml")
	must(t, atomicWrite(filepath.Join(oldDir, "docker-compose.yml"), compose, 0600))
	old := r
	old.Version = "0.0.8"
	must(t, writeJSON(filepath.Join(oldDir, "release.json"), old))
	snapshot, err := configSnapshot(w.config(), w.oldID)
	must(t, err)
	config := filepath.Join(oldDir, "config.json")
	must(t, atomicWrite(config, snapshot, 0600))
	must(t, writeJSON(filepath.Join(w.state, "active.json"), installed{Version: old.Version, Schema: old.Schema, ImageID: w.oldID, Digest: "sha256:" + strings.Repeat("3", 64), Source: "ghcr.io/mazixs/dockge2:latest", Project: "panel", DataDir: w.data, Config: config, ReleaseDir: oldDir, Mode: "release"}))
	w.verifier = filepath.Join(dir, "cosign")
	must(t, atomicWrite(w.verifier, []byte("test verifier boundary"), 0700))
	w.runner = &fakeRunner{call: w.command}
	return w
}
func (w *deploymentFixture) config() composeConfig {
	value := map[string]any{"name": "panel", "services": map[string]any{"dockge": map[string]any{"image": "ghcr.io/mazixs/dockge2:latest", "environment": map[string]any{"SECRET": "cost$5"}, "volumes": []any{map[string]any{"type": "bind", "source": w.data, "target": "/app/data"}}}}}
	b, _ := json.Marshal(value)
	c, err := parseConfig(b)
	must(w.t, err)
	return c
}
func (w *deploymentFixture) container() *containerInfo {
	c := &containerInfo{ID: w.containerID, Image: w.image}
	c.Config.Labels = map[string]string{"com.docker.compose.project.working_dir": w.dir}
	c.Config.Env = []string{"SECRET=cost$5"}
	c.State.Running = w.running
	c.State.Health = &struct {
		Status string `json:"Status"`
	}{Status: "healthy"}
	c.Mounts = append(c.Mounts, struct {
		Type        string `json:"Type"`
		Source      string `json:"Source"`
		Destination string `json:"Destination"`
	}{"bind", w.data, "/app/data"})
	return c
}
func encoded(v any) ([]byte, error) { return json.Marshal(v) }
func (w *deploymentFixture) command(command string, a []string) ([]byte, error) {
	if command == w.verifier {
		return nil, nil
	}
	if w.crashPhase != "" {
		op, err := loadOperation(filepath.Join(w.state, "operation.json"))
		if err == nil && op.Phase == w.crashPhase {
			panic("simulated process loss at " + op.Phase)
		}
	}
	if command != "docker" {
		w.t.Fatalf("unexpected command %s", command)
	}
	switch a[0] {
	case "context":
		return []byte("unix:///var/run/docker.sock"), nil
	case "info":
		return []byte("daemon-" + w.dir), nil
	case "version":
		return []byte("28.0.0"), nil
	case "ps":
		return []byte(w.containerID), nil
	case "inspect":
		return encoded([]*containerInfo{w.container()})
	case "pull":
		if w.crashAt == "pull" {
			panic("simulated process loss")
		}
		if w.pullFailure != "" {
			return nil, errors.New(w.pullFailure)
		}
		return nil, nil
	case "exec":
		if a[2] == "node" {
			if a[3] == "-e" {
				return []byte(w.release.Schema), nil
			}
			v := w.oldVersion
			if w.image == w.targetID {
				v = w.release.Version
			}
			return []byte(v), nil
		}
		return nil, nil
	case "run":
		if w.snapshotFailure != "" {
			return nil, errors.New(w.snapshotFailure)
		}
		return nil, nil
	case "image":
		if a[1] == "tag" {
			return nil, nil
		}
		ref := a[2]
		i := imageInfo{ID: w.targetID, Architecture: runtime.GOARCH, OS: "linux"}
		i.Config.Labels = map[string]string{"org.opencontainers.image.version": w.release.Version, "org.opencontainers.image.revision": w.release.Commit}
		if ref == w.oldID {
			i.ID = w.oldID
			i.Config.Labels["org.opencontainers.image.version"] = w.oldVersion
			i.Config.Labels["org.opencontainers.image.revision"] = w.oldCommit
			i.RepoDigests = w.oldRepoDigests
		}
		return encoded([]imageInfo{i})
	case "compose":
		if a[1] == "version" {
			return []byte("2.40.0"), nil
		}
		joined := " " + strings.Join(a, " ") + " "
		if strings.Contains(joined, " config ") {
			c := w.config()
			return encoded(c.Extra)
		}
		if strings.Contains(joined, " stop ") {
			w.stops++
			w.running = false
			return nil, nil
		}
		if strings.Contains(joined, " up ") {
			w.starts++
			var file string
			for i := range a {
				if a[i] == "-f" {
					file = a[i+1]
				}
			}
			b, err := os.ReadFile(file)
			if err != nil {
				return nil, err
			}
			c, err := parseConfig(b)
			if err != nil {
				return nil, err
			}
			if c.image() == w.oldID {
				w.image = w.oldID
				w.containerID = "recovered"
				w.running = true
				return nil, nil
			}
			if w.crashAt == "up" {
				panic("simulated process loss")
			}
			w.image = w.targetID
			w.containerID = "target"
			w.running = true
			if w.startFailure != "" {
				return nil, errors.New(w.startFailure)
			}
			return nil, os.WriteFile(filepath.Join(w.data, "dockge.db"), []byte("new fixture data"), 0600)
		}
	}
	w.t.Fatalf("unexpected Docker call: %v", a)
	return nil, nil
}
func (w *deploymentFixture) execute(extra func(*options)) error {
	out, err := os.CreateTemp(w.dir, "log")
	must(w.t, err)
	defer out.Close()
	o := options{dir: w.dir, update: true, version: w.release.Version, releaseDir: w.assets, verifier: w.verifier, yes: true, composeFile: "docker-compose.yml"}
	if extra != nil {
		extra(&o)
	}
	return (&engine{run: w.runner, out: out}).execute(context.Background(), o)
}
func TestPreviewAndPullFailureKeepDeployment(t *testing.T) {
	for _, kind := range []string{"preview", "pull"} {
		t.Run(kind, func(t *testing.T) {
			w := newDeployment(t)
			if kind == "pull" {
				w.pullFailure = "registry unavailable"
			}
			err := w.execute(func(o *options) { o.dryRun = kind == "preview" })
			if kind == "preview" {
				must(t, err)
			} else if err == nil {
				t.Fatal("pull failure hidden")
			}
			if w.stops != 0 || w.starts != 0 || w.image != w.oldID {
				t.Fatal("active deployment changed")
			}
			for _, call := range w.runner.calls {
				if strings.Contains(call, "git ") || strings.Contains(call, "docker build ") {
					t.Fatal(call)
				}
			}
		})
	}
}

func unmanagedRelease(t *testing.T) *deploymentFixture {
	t.Helper()
	w := newDeployment(t)
	w.oldVersion = "0.0.10"
	w.oldCommit = "f6bdbfb2f907fd78ba3737edd836f5b5c1e2d822"
	w.oldDigest = "sha256:edf9bd51346f47c9c89d65b6bbe9c1da3d2d028dbcb45109dfc895164871d71b"
	w.oldRepoDigests = []string{"ghcr.io/mazixs/dockge2@" + w.oldDigest}
	w.release.Version = "0.0.11"
	base, err := os.ReadFile(filepath.Join("..", "..", "docker-compose.yml"))
	must(t, err)
	if fileHash(base) != "adeb402bd932e0eaf19930bbd5ba3b24e482a2376707c32e03e43645986a187f" {
		t.Fatal("unmanaged import fixture is not the 0.0.10 vendor file")
	}
	must(t, atomicWrite(filepath.Join(w.dir, "docker-compose.yml"), base, 0600))
	w.release.Legacy = map[string]Legacy{w.oldVersion: {ComposeHash: fileHash(base), Schema: w.release.Schema}}
	must(t, writeJSON(filepath.Join(w.assets, "release.json"), w.release))
	must(t, os.Remove(filepath.Join(w.state, "active.json")))
	return w
}

func TestUnmanagedPublishedReleaseCanBeImported(t *testing.T) {
	w := unmanagedRelease(t)
	must(t, w.execute(func(o *options) { o.dryRun = true }))
	if w.stops != 0 || w.starts != 0 {
		t.Fatal("preview changed deployment")
	}
	must(t, w.execute(nil))
	var active installed
	data, err := os.ReadFile(filepath.Join(w.state, "active.json"))
	must(t, err)
	must(t, json.Unmarshal(data, &active))
	if active.Version != "0.0.11" || active.Mode != "release" || w.starts != 1 {
		t.Fatal("unmanaged release was not adopted")
	}
}

func TestUnmanagedImportRejectsUnverifiedImage(t *testing.T) {
	for _, kind := range []string{"missing digest", "wrong revision", "wrong vendor"} {
		t.Run(kind, func(t *testing.T) {
			w := unmanagedRelease(t)
			switch kind {
			case "missing digest":
				w.oldRepoDigests = nil
			case "wrong revision":
				w.oldCommit = strings.Repeat("c", 40)
			case "wrong vendor":
				must(t, atomicWrite(filepath.Join(w.dir, "docker-compose.yml"), []byte("modified vendor"), 0600))
			}
			if err := w.execute(func(o *options) { o.dryRun = true }); err == nil || w.stops != 0 {
				t.Fatal("unverified image or vendor was accepted")
			}
		})
	}
}
func TestSuccessNoopAndExplicitDataRestore(t *testing.T) {
	w := newDeployment(t)
	must(t, w.execute(func(o *options) { o.image = "mirror.example/panel:latest" }))
	if w.image != w.targetID || !w.running {
		t.Fatal("target not running")
	}
	previous, err := os.ReadFile(filepath.Join(w.state, "previous.json"))
	must(t, err)
	must(t, w.execute(nil))
	again, err := os.ReadFile(filepath.Join(w.state, "previous.json"))
	must(t, err)
	if string(previous) != string(again) || w.starts != 1 {
		t.Fatal("no-op rotated the distinct previous deployment")
	}
	var op operation
	must(t, json.Unmarshal(previous, &op))
	if op.Previous.Source != "ghcr.io/mazixs/dockge2:latest" || op.Target.Source != "mirror.example/panel:latest" {
		t.Fatal("source selection was not preserved across rollback")
	}
	old, err := os.ReadFile(op.Previous.Config)
	must(t, err)
	if !strings.Contains(string(old), "cost$$5") || strings.Contains(string(old), "cost$$$$5") {
		t.Fatal("snapshot interpolation changed")
	}
	must(t, w.execute(func(o *options) { o.rollback = true; o.restoreData = true; o.version = "" }))
	data, err := os.ReadFile(filepath.Join(w.data, "dockge.db"))
	must(t, err)
	if string(data) != "old fixture data" || w.image != w.oldID {
		t.Fatal("previous deployment/data not restored")
	}
	failed, err := os.ReadFile(filepath.Join(w.data+".dockge-failed-"+op.ID, "dockge.db"))
	must(t, err)
	if string(failed) != "new fixture data" {
		t.Fatal("newer data lost")
	}
}
func TestFailedSchemaChangeStopsTargetWithoutRewindingData(t *testing.T) {
	w := newDeployment(t)
	w.release.Schema = strings.Repeat("f", 64)
	must(t, writeJSON(filepath.Join(w.assets, "release.json"), w.release))
	w.startFailure = "candidate crashed"
	err := w.execute(nil)
	if err == nil || !strings.Contains(err.Error(), "restore-data") {
		t.Fatal(err)
	}
	op, err := loadOperation(filepath.Join(w.state, "operation.json"))
	must(t, err)
	if op.Phase != "recovery-required" || w.running || !op.BackupVerified || w.starts != 1 {
		t.Fatal("unsafe automatic recovery", op.Phase, w.running, w.starts)
	}
	if err = w.execute(nil); err == nil || !strings.Contains(err.Error(), "recovery-required") {
		t.Fatal("unfinished operation overwritten")
	}
}
func TestProcessLossBeforeAndAfterCutoverIsRecorded(t *testing.T) {
	for _, phase := range []string{"pull", "up"} {
		t.Run(phase, func(t *testing.T) {
			w := newDeployment(t)
			w.crashAt = phase
			func() {
				defer func() {
					if recover() == nil {
						t.Fatal("failure injection did not run")
					}
				}()
				_ = w.execute(nil)
			}()
			op, err := loadOperation(filepath.Join(w.state, "operation.json"))
			must(t, err)
			if phase == "pull" && op.Phase != "prepared" || phase == "up" && (op.Phase != "starting-target" || !op.BackupVerified) {
				t.Fatal(op.Phase)
			}
			if err = w.execute(nil); err == nil {
				t.Fatal("unfinished journal ignored")
			}
		})
	}
}

func TestBackupFailureRecoversPreviousWithoutKeepingPartialCopy(t *testing.T) {
	w := newDeployment(t)
	w.snapshotFailure = "SQLite integrity check failed"
	err := w.execute(nil)
	if err == nil || !strings.Contains(err.Error(), "was recovered") {
		t.Fatal(err)
	}
	op, err := loadOperation(filepath.Join(w.state, "operation.json"))
	must(t, err)
	if op.Phase != "recovered" || w.image != w.oldID || !w.running || exists(op.Backup) {
		t.Fatal("failed snapshot did not recover cleanly")
	}
}
func TestProducerAndConsumerAgreeOnSchemaIdentity(t *testing.T) {
	expected, err := schemaHash("../..")
	must(t, err)
	actual, err := (commandRunner{}).run(context.Background(), "node", "--input-type=module", "-e", `import {schemaHash} from '../release/manifest.mjs';console.log(schemaHash('../..'));`)
	must(t, err)
	if strings.TrimSpace(string(actual)) != expected {
		t.Fatalf("producer and consumer schema hashes differ: %s / %s", actual, expected)
	}
}

func TestEveryCutoverPhaseBlocksAnUnreviewedRetry(t *testing.T) {
	for _, phase := range []string{"prepared", "downloaded", "stopping", "backing-up", "starting-target", "checking-target"} {
		t.Run(phase, func(t *testing.T) {
			w := newDeployment(t)
			w.crashPhase = phase
			func() {
				defer func() {
					if recover() == nil {
						t.Fatal("phase injection not reached")
					}
				}()
				_ = w.execute(nil)
			}()
			op, err := loadOperation(filepath.Join(w.state, "operation.json"))
			must(t, err)
			if op.Phase != phase {
				t.Fatal(op.Phase)
			}
			if err = w.execute(nil); err == nil {
				t.Fatal("interrupted operation replaced")
			}
		})
	}
}
