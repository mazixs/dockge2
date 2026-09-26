package main

import (
	"bytes"
	"context"
	"debug/elf"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
	"unicode/utf8"
)

func TestMain(m *testing.M) {
	stabilityWait = 10 * time.Millisecond
	os.Exit(m.Run())
}

type progressRun struct {
	code           int
	stdout, stderr string
	lines          []map[string]any
}

// invoke runs the command line the installed launcher builds, with the fixture's release.
func (w *deploymentFixture) invoke(ctx context.Context, args ...string) (int, string, string) {
	var stdout, stderr bytes.Buffer
	base := []string{"--dir", w.dir, "--verifier", w.verifier, "--release-dir", w.assets, "--update"}
	code := cli(ctx, append(base, args...), &stdout, &stderr, w.engine(nil))
	return code, stdout.String(), stderr.String()
}
func (w *deploymentFixture) cli(args ...string) progressRun {
	return w.cliContext(context.Background(), args...)
}
func (w *deploymentFixture) cliContext(ctx context.Context, args ...string) progressRun {
	w.t.Helper()
	code, stdout, stderr := w.invoke(ctx, append([]string{"--progress", "json"}, args...)...)
	return parseProgress(w.t, code, stdout, stderr)
}

// parseProgress fails on any stdout line that is not a schema 1 JSON line.
func parseProgress(t *testing.T, code int, stdout, stderr string) progressRun {
	t.Helper()
	r := progressRun{code: code, stdout: stdout, stderr: stderr}
	for _, line := range strings.Split(stdout, "\n") {
		if line == "" {
			continue
		}
		var v map[string]any
		if err := json.Unmarshal([]byte(line), &v); err != nil || v["v"] != float64(1) {
			t.Fatalf("stdout carries a line that is not progress: %q", line)
		}
		r.lines = append(r.lines, v)
	}
	return r
}
func (r progressRun) kinds() []string {
	kinds := []string{}
	for _, line := range r.lines {
		kinds = append(kinds, line["dockge2"].(string))
	}
	return kinds
}
func (r progressRun) phases() []string {
	phases := []string{}
	for _, line := range r.lines {
		if line["dockge2"] == "phase" {
			phases = append(phases, line["phase"].(string))
		}
	}
	return phases
}

// result asserts that the run ended with exactly one result line.
func (r progressRun) result(t *testing.T) map[string]any {
	t.Helper()
	kinds := r.kinds()
	if len(kinds) == 0 || kinds[len(kinds)-1] != "result" || slices.Index(kinds, "result") != len(kinds)-1 {
		t.Fatalf("not exactly one final result line: %v\n%s", kinds, r.stderr)
	}
	return r.lines[len(r.lines)-1]
}
func keys(v map[string]any) []string {
	k := []string{}
	for key := range v {
		k = append(k, key)
	}
	slices.Sort(k)
	return k
}
func changeSchema(t *testing.T, w *deploymentFixture) {
	w.release.Schema = strings.Repeat("f", 64)
	must(t, writeJSON(filepath.Join(w.assets, "release.json"), w.release))
}
func readData(t *testing.T, dir string) string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(dir, "dockge.db"))
	must(t, err)
	return string(b)
}
func journal(t *testing.T, w *deploymentFixture) operation {
	t.Helper()
	op, err := loadOperation(filepath.Join(w.state, "operation.json"))
	must(t, err)
	return op
}

func TestProgressReportsEveryJournalWriteAndOneResult(t *testing.T) {
	w := newDeployment(t)
	r := w.cli("--version", "0.0.9", "--yes")
	if r.code != 0 {
		t.Fatal(r.code, r.stderr)
	}
	if want := []string{"prepared", "downloaded", "stopping", "backing-up", "starting-target", "checking-target", "success"}; !slices.Equal(r.phases(), want) {
		t.Fatal(r.phases())
	}
	result := r.result(t)
	if !slices.Equal(keys(result), []string{"dockge2", "from", "op", "outcome", "phase", "to", "v"}) {
		t.Fatal(keys(result))
	}
	if result["outcome"] != "success" || result["phase"] != "success" || result["from"] != "0.0.8" || result["to"] != "0.0.9" || result["op"] != journal(t, w).ID {
		t.Fatal(result)
	}
	for _, line := range r.lines[:len(r.lines)-1] {
		at, err := time.Parse(time.RFC3339, line["at"].(string))
		if err != nil || !strings.HasSuffix(line["at"].(string), "Z") || time.Since(at) > time.Minute {
			t.Fatal("phase time is not RFC3339 UTC", line["at"])
		}
		if line["op"] != result["op"] || line["from"] != "0.0.8" || line["to"] != "0.0.9" {
			t.Fatal(line)
		}
	}
	if !strings.Contains(r.stderr, "Update phase: prepared") || !strings.Contains(r.stderr, "Update succeeded") {
		t.Fatal("human text left stderr:", r.stderr)
	}
	// Cosign keeps its trust root in the installation's state across helper containers.
	if len(w.runner.envs) != 1 || !slices.Contains(w.runner.envs[0], "HOME="+filepath.Join(w.state, "cosign")) {
		t.Fatal(w.runner.envs)
	}
}

func TestProgressDryRunPreviewsWithoutAnOperation(t *testing.T) {
	w := newDeployment(t)
	changeSchema(t, w)
	r := w.cli("--version", "0.0.9", "--dry-run")
	if r.code != 0 || !slices.Equal(r.kinds(), []string{"preview", "result"}) {
		t.Fatal(r.code, r.kinds(), r.stderr)
	}
	preview := r.lines[0]
	if preview["from"] != "0.0.8" || preview["to"] != "0.0.9" || preview["channel"] != "ghcr.io/mazixs/dockge2:latest" || preview["schemaChanges"] != true || fmt.Sprint(preview["fields"]) != "[image]" {
		t.Fatal(preview)
	}
	if result := r.result(t); result["outcome"] != "previewed" || result["op"] != "" || result["phase"] != "" || result["to"] != "0.0.9" {
		t.Fatal(result)
	}
	if exists(filepath.Join(w.state, "operation.json")) || w.stops != 0 {
		t.Fatal("preview recorded an operation")
	}
	// Without --progress stdout keeps the human text it always had.
	code, stdout, _ := w.invoke(context.Background(), "--version", "0.0.9", "--dry-run")
	if code != 0 || !strings.Contains(stdout, "Preview only") || strings.Contains(stdout, "{") {
		t.Fatal(code, stdout)
	}
}

func TestProgressNoChangeIsSuccessfulWithoutRestart(t *testing.T) {
	w := newDeployment(t)
	if r := w.cli("--version", "0.0.9", "--yes"); r.code != 0 {
		t.Fatal(r.stderr)
	}
	preview := w.cli("--version", "0.0.9", "--dry-run")
	if !strings.Contains(preview.stdout, `"fields":[]`) || preview.lines[0]["schemaChanges"] != false {
		t.Fatal(preview.stdout)
	}
	r := w.cli("--version", "0.0.9", "--yes")
	result := r.result(t)
	if r.code != 0 || !slices.Equal(r.phases(), []string{"prepared", "success"}) || result["outcome"] != "no-change" || result["phase"] != "success" || result["from"] != "0.0.9" || result["to"] != "0.0.9" {
		t.Fatal(r.code, r.phases(), result)
	}
	if w.starts != 1 || w.stops != 1 {
		t.Fatal("no-change restarted the panel")
	}
}

// The web interface runs the updater with the Compose of the panel's image, while the
// deployment was recorded by the Compose of the host.
func TestProgressNoChangeAcrossComposeVersions(t *testing.T) {
	for name, c := range map[string]struct{ recorded, reads bool }{
		"recorded by Compose 2, read by Compose 5":         {false, true},
		"recorded by Compose 5, read by Compose 2":         {true, false},
		"recorded by Compose 5 before binds were explicit": {true, true},
	} {
		t.Run(name, func(t *testing.T) {
			w := newDeployment(t)
			w.compose5 = c.recorded
			if r := w.cli("--version", "0.0.9", "--yes"); r.code != 0 {
				t.Fatal(r.stderr)
			}
			if c.recorded && c.reads {
				data, err := os.ReadFile(filepath.Join(w.state, "active.json"))
				must(t, err)
				var active installed
				must(t, json.Unmarshal(data, &active))
				recorded, err := os.ReadFile(active.Config)
				must(t, err)
				legacy := strings.ReplaceAll(string(recorded), `"create_host_path": true`, "")
				if legacy == string(recorded) {
					t.Fatal(string(recorded))
				}
				must(t, os.WriteFile(active.Config, []byte(legacy), 0600))
			}
			w.compose5 = c.reads
			preview := w.cli("--version", "0.0.9", "--dry-run")
			if !strings.Contains(preview.stdout, `"fields":[]`) {
				t.Fatal(preview.stdout)
			}
			r := w.cli("--version", "0.0.9", "--yes")
			if r.code != 0 || r.result(t)["outcome"] != "no-change" || w.starts != 1 {
				t.Fatal(r.code, r.stdout, w.starts)
			}
		})
	}
}

func TestProgressRefusesWithAResultLine(t *testing.T) {
	w := newDeployment(t)
	changeSchema(t, w)
	w.startFailure = "candidate crashed"
	if r := w.cli("--version", "0.0.9", "--yes"); r.result(t)["outcome"] != "recovery-required" {
		t.Fatal(r.stdout)
	}
	r := w.cli("--version", "0.0.9", "--yes")
	result := r.result(t)
	if r.code != 1 || len(r.lines) != 1 || result["outcome"] != "refused" || result["op"] != "" || !strings.Contains(result["error"].(string), "recovery-required") {
		t.Fatal(r.code, r.stdout)
	}
	// Argument errors exit 2 and still answer; a new updater never looks outdated to the panel.
	r = w.cli("--version", "v0.0.9", "--dry-run", "--restore-on-failed-start")
	result = r.result(t)
	if r.code != 2 || len(r.lines) != 1 || result["outcome"] != "refused" || result["to"] != "0.0.9" || !strings.Contains(result["error"].(string), "--update --yes") {
		t.Fatal(r.code, r.stdout)
	}
	if code, stdout, _ := w.invoke(context.Background(), "--progress", "xml", "--version", "0.0.9"); code != 2 || stdout != "" {
		t.Fatal("an unknown progress format was answered", code, stdout)
	}
	for _, args := range [][]string{{"--rollback"}, {"--resume"}} {
		if code, stdout, _ := w.invoke(context.Background(), append([]string{"--progress", "json"}, args...)...); code != 2 || !strings.Contains(stdout, `"refused"`) {
			t.Fatal(args, code, stdout)
		}
	}
}

func TestProgressOutcomesOfAFailedUpdate(t *testing.T) {
	t.Run("recovery-required without restore", func(t *testing.T) {
		w := newDeployment(t)
		changeSchema(t, w)
		w.startFailure = "candidate crashed\nwith a second line"
		r := w.cli("--version", "0.0.9", "--yes")
		result := r.result(t)
		phases := r.phases()
		if r.code != 1 || result["outcome"] != "recovery-required" || result["phase"] != "recovery-required" || phases[len(phases)-2] != "starting-target" {
			t.Fatal(r.code, phases, result)
		}
		if _, ok := result["restoredData"]; ok || strings.Contains(result["error"].(string), "\n") || !strings.Contains(result["error"].(string), "candidate crashed with a second line") {
			t.Fatal(result)
		}
	})
	t.Run("recovered before the target started", func(t *testing.T) {
		w := newDeployment(t)
		w.snapshotFailure = "SQLite integrity check failed"
		r := w.cli("--version", "0.0.9", "--yes")
		result := r.result(t)
		if r.code != 1 || result["outcome"] != "recovered" || result["restoredData"] != false || !slices.Equal(r.phases()[3:], []string{"backing-up", "recovered"}) {
			t.Fatal(r.code, r.phases(), result)
		}
	})
	t.Run("same schema keeps the data", func(t *testing.T) {
		w := newDeployment(t)
		w.startFailure = "candidate crashed"
		r := w.cli("--version", "0.0.9", "--yes", "--restore-on-failed-start")
		result := r.result(t)
		if r.code != 1 || result["outcome"] != "recovered" || result["restoredData"] != false || w.restores != 0 || readData(t, w.data) != "new fixture data" || w.image != w.oldID {
			t.Fatal(r.code, result, w.restores)
		}
	})
	t.Run("journal write failure", func(t *testing.T) {
		if os.Geteuid() == 0 {
			t.Skip("root ignores directory permissions")
		}
		w := newDeployment(t)
		t.Cleanup(func() { _ = os.Chmod(w.state, 0700) })
		w.hook = func(_ string, a []string) {
			if len(a) > 0 && a[0] == "pull" {
				must(t, os.Chmod(w.state, 0500))
			}
		}
		r := w.cli("--version", "0.0.9", "--yes")
		result := r.result(t)
		if r.code != 1 || !slices.Equal(r.phases(), []string{"prepared"}) || result["outcome"] != "recovery-required" || result["phase"] != "prepared" || w.stops != 0 {
			t.Fatal(r.code, r.phases(), result)
		}
	})
}

func TestRestoreOnFailedStartReturnsThePreviousDeploymentAndData(t *testing.T) {
	w := newDeployment(t)
	changeSchema(t, w)
	w.startFailure = "target image is not running and healthy"
	r := w.cli("--version", "0.0.9", "--yes", "--restore-on-failed-start")
	result := r.result(t)
	phases := r.phases()
	if r.code != 1 || !slices.Equal(phases[len(phases)-3:], []string{"starting-target", "rolling-back", "recovered"}) {
		t.Fatal(r.code, phases, r.stderr)
	}
	if result["outcome"] != "recovered" || result["restoredData"] != true || result["phase"] != "recovered" || !strings.Contains(result["error"].(string), "target image is not running and healthy") {
		t.Fatal(result)
	}
	op := journal(t, w)
	if op.Phase != "recovered" || !op.RestoreData || w.restores != 1 || w.image != w.oldID || !w.running {
		t.Fatal("previous deployment not restored", op.Phase, w.restores, w.image)
	}
	if readData(t, w.data) != "old fixture data" || readData(t, failedDataDir(w.data, op.ID)) != "new fixture data" {
		t.Fatal("data not restored, or post-update data lost")
	}
	// A page that missed the result learns the restore from the journal.
	if status := w.cli("--status"); status.code != 0 || len(status.lines) != 1 || status.lines[0]["dockge2"] != "journal" || status.lines[0]["restoredData"] != true {
		t.Fatal("the journal line lost the restore:", status.stdout)
	}
	// A recovered operation is final: the next update is not blocked.
	if r = w.cli("--version", "0.0.9", "--dry-run"); r.code != 0 {
		t.Fatal(r.stderr)
	}
}

func TestRestoreOnFailedStartRefusesAnUnverifiableSnapshot(t *testing.T) {
	w := newDeployment(t)
	changeSchema(t, w)
	w.startFailure = "candidate crashed"
	w.hook = func(_ string, a []string) {
		if len(a) > 3 && a[0] == "compose" && slices.Contains(a, "up") {
			if op, err := loadOperation(filepath.Join(w.state, "operation.json")); err == nil && op.Phase == "starting-target" && op.BackupVerified {
				must(t, os.WriteFile(filepath.Join(op.Backup, "dockge.db"), []byte("corrupted"), 0600))
			}
		}
	}
	r := w.cli("--version", "0.0.9", "--yes", "--restore-on-failed-start")
	result := r.result(t)
	if r.code != 1 || result["outcome"] != "recovery-required" || slices.Contains(r.phases(), "rolling-back") || !strings.Contains(result["error"].(string), "automatic data restore did not complete") {
		t.Fatal(r.code, r.phases(), result)
	}
	if w.restores != 0 || journal(t, w).RestoreData || readData(t, w.data) != "new fixture data" || w.running {
		t.Fatal("data changed on an unverifiable snapshot")
	}
}

func TestFailedAutomaticRestoreLeavesAnExplicitRollback(t *testing.T) {
	w := newDeployment(t)
	changeSchema(t, w)
	w.startFailure = "candidate crashed"
	w.restoreFailure = "restore container exited with status 1"
	r := w.cli("--version", "0.0.9", "--yes", "--restore-on-failed-start")
	result := r.result(t)
	phases := r.phases()
	if r.code != 1 || result["outcome"] != "recovery-required" || !slices.Equal(phases[len(phases)-2:], []string{"rolling-back", "recovery-required"}) {
		t.Fatal(r.code, phases, result)
	}
	op := journal(t, w)
	if !op.RestoreData || w.running || readData(t, w.data) != "new fixture data" || !slices.Equal(w.removed, []string{"dockge2-restore-panel-" + op.ID}) {
		t.Fatal("unexpected state after a failed restore", w.removed)
	}
	w.restoreFailure = ""
	if err := w.execute(func(o *options) { o.rollback = true; o.version = "" }); err == nil || !strings.Contains(err.Error(), "--restore-data") {
		t.Fatal("rollback without the snapshot after a restore was recorded:", err)
	}
	must(t, w.execute(func(o *options) { o.rollback = true; o.restoreData = true; o.version = "" }))
	if readData(t, w.data) != "old fixture data" || readData(t, failedDataDir(w.data, op.ID)) != "new fixture data" || w.image != w.oldID || w.restores != 2 {
		t.Fatal("explicit rollback did not finish the restore")
	}
}

// docker run --rm that loses its client leaves the container to the daemon, still writing
// into the data directory: the updater removes it, and says so honestly when it cannot.
func TestRestoreContainerDoesNotOutliveTheUpdater(t *testing.T) {
	for _, c := range []struct {
		name, failure, stop, phase string
		left                       bool
		removed                    int
	}{
		{"client killed on the deadline", "signal: killed", "", "recovery-required", true, 1},
		{"stop not confirmed", "signal: killed", "Cannot connect to the Docker daemon at unix:///var/run/docker.sock", "rolling-back", true, 1},
		{"name taken by another restore", `docker: Error response from daemon: Conflict. The container name "/dockge2-restore-panel" is already in use by container "0123abcd".`, "", "recovery-required", false, 0},
	} {
		t.Run(c.name, func(t *testing.T) {
			w := newDeployment(t)
			changeSchema(t, w)
			w.startFailure = "candidate crashed"
			w.restoreFailure, w.stopFailure, w.restoreLeft = c.failure, c.stop, c.left
			r := w.cli("--version", "0.0.9", "--yes", "--restore-on-failed-start")
			result := r.result(t)
			phases := r.phases()
			if r.code != 1 || result["outcome"] != "recovery-required" || result["phase"] != c.phase || phases[len(phases)-1] != c.phase || journal(t, w).Phase != c.phase {
				t.Fatal(r.code, phases, result)
			}
			if len(w.removed) != c.removed || c.stop == "" && w.restoreLeft {
				t.Fatal("restore container left behind", w.removed, w.restoreLeft)
			}
			if running := strings.Contains(result["error"].(string), errRestoreRunning.Error()); running != (c.stop != "") {
				t.Fatal("the error hides or invents a running restore:", result["error"])
			}
		})
	}
	t.Run("explicit rollback", func(t *testing.T) {
		w := newDeployment(t)
		changeSchema(t, w)
		w.startFailure = "candidate crashed"
		if r := w.cli("--version", "0.0.9", "--yes"); r.code != 1 {
			t.Fatal(r.stderr)
		}
		w.restoreFailure, w.stopFailure, w.restoreLeft = "signal: killed", "Cannot connect to the Docker daemon", true
		err := w.execute(func(o *options) { o.update = false; o.rollback = true; o.restoreData = true; o.version = "" })
		if !errors.Is(err, errRestoreRunning) || journal(t, w).Phase != "rolling-back" {
			t.Fatal(err, journal(t, w).Phase)
		}
	})
}

func TestAttendedRunRemovesItsContainerOnItsOwnDeadline(t *testing.T) {
	const name = "dockge2-restore-panel-20260926T000000.000000000"
	for _, c := range []struct {
		label, run, rm, wait string
		calls                []string
		running              bool
	}{
		{"removed", "signal: killed", "", "", []string{"run", "rm"}, false},
		{"already gone", "exit status 1", "Error response from daemon: No such container: " + name, "", []string{"run", "rm"}, false},
		{"removed by --rm after its exit", "exit status 1", "Error response from daemon: removal of container " + name + " is already in progress", "", []string{"run", "rm", "wait"}, false},
		{"removal in progress, wait unanswered", "exit status 1", "removal of container " + name + " is already in progress", "Cannot connect to the Docker daemon", []string{"run", "rm", "wait"}, true},
		{"daemon unreachable", "signal: killed", "Cannot connect to the Docker daemon", "", []string{"run", "rm"}, true},
		{"name taken", "Conflict. The container name \"/" + name + "\" is already in use by container \"0123abcd\".", "", "", []string{"run"}, false},
	} {
		t.Run(c.label, func(t *testing.T) {
			answers := map[string]string{"run": c.run, "rm": c.rm, "wait": c.wait}
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			runner := &fakeRunner{}
			runner.call = func(_ string, a []string) ([]byte, error) {
				// A killed client is the run's deadline passing; the stop must not inherit it.
				if a[0] == "run" && c.run == "signal: killed" {
					cancel()
				}
				if answers[a[0]] != "" {
					return nil, daemonError(answers[a[0]])
				}
				return nil, nil
			}
			err := docker{run: runner}.runAttended(ctx, name, "--network", "none", "image")
			calls := []string{}
			for _, call := range runner.calls {
				calls = append(calls, strings.Fields(call)[1])
				if !strings.HasPrefix(call, "docker run") && !strings.HasSuffix(call, " "+name) {
					t.Fatal("stopped by anything but its name:", call)
				}
			}
			if err == nil || errors.Is(err, errRestoreRunning) != c.running || !slices.Equal(calls, c.calls) {
				t.Fatal(err, calls)
			}
		})
	}
}

// The reviewer's reproduction on a real daemon: the client dies on the deadline, and the
// container is gone when the call returns. Opt in with DOCKGE_DOCKER_INTEGRATION=1.
func TestAttendedRunOnDocker(t *testing.T) {
	const image = "bash:5.2"
	if os.Getenv("DOCKGE_DOCKER_INTEGRATION") != "1" {
		t.Skip("set DOCKGE_DOCKER_INTEGRATION=1 to run against the local Docker daemon")
	}
	if err := exec.Command("docker", "image", "inspect", image).Run(); err != nil {
		t.Skip(image + " is not present locally")
	}
	name := fmt.Sprintf("dockge2-restore-test-%d", time.Now().UnixNano())
	t.Cleanup(func() { _ = exec.Command("docker", "rm", "--force", name).Run() })
	ctx, cancel := context.WithTimeout(context.Background(), 1200*time.Millisecond)
	defer cancel()
	started := time.Now()
	err := docker{run: commandRunner{}}.runAttended(ctx, name, "--pull", "never", "--network", "none", image, "sleep", "30")
	if err == nil || errors.Is(err, errRestoreRunning) || time.Since(started) < time.Second {
		t.Fatal("the run did not end on its deadline:", err)
	}
	out, err := exec.Command("docker", "ps", "--all", "--quiet", "--filter", "name=^/"+name+"$").Output()
	if err != nil || strings.TrimSpace(string(out)) != "" {
		t.Fatal("the container outlived its client:", string(out), err)
	}
}

// The markers of a restore belong to the operation id. A target run again after the restore
// would migrate the restored data, and the next rollback would take it for the snapshot.
func TestRestoredOperationCannotResumeTheTarget(t *testing.T) {
	w := newDeployment(t)
	changeSchema(t, w)
	w.startFailure = "candidate crashed"
	w.previousFailure = "previous image did not start"
	r := w.cli("--version", "0.0.9", "--yes", "--restore-on-failed-start")
	if result := r.result(t); r.code != 1 || result["outcome"] != "recovery-required" {
		t.Fatal(r.code, result)
	}
	op := journal(t, w)
	if !op.RestoreData || w.restores != 1 || readData(t, w.data) != "old fixture data" || !exists(failedDataDir(w.data, op.ID)) {
		t.Fatal("the restore did not finish before the previous start failed")
	}
	starts := w.starts
	for _, dryRun := range []bool{true, false} {
		err := w.execute(func(o *options) { o.update = false; o.resume = true; o.version = ""; o.dryRun = dryRun })
		if err == nil || !strings.Contains(err.Error(), "--rollback --restore-data") {
			t.Fatal("resume after the restore:", err)
		}
	}
	if w.starts != starts || readData(t, w.data) != "old fixture data" || journal(t, w).Phase != "recovery-required" {
		t.Fatal("a refused resume changed the deployment or the data")
	}
	// The marker alone refuses too: a journal written before the restore recorded it
	op.RestoreData = false
	must(t, writeJSON(filepath.Join(w.state, "operation.json"), op))
	if err := w.execute(func(o *options) { o.update = false; o.resume = true; o.version = "" }); err == nil {
		t.Fatal("resume with the restore marker on disk")
	}
	op.RestoreData = true
	must(t, writeJSON(filepath.Join(w.state, "operation.json"), op))
	w.previousFailure = ""
	must(t, w.execute(func(o *options) { o.update = false; o.rollback = true; o.restoreData = true; o.version = "" }))
	if readData(t, w.data) != "old fixture data" || readData(t, failedDataDir(w.data, op.ID)) != "new fixture data" || w.image != w.oldID || journal(t, w).Phase != "recovered" {
		t.Fatal("the rollback did not end on the restored snapshot")
	}
	if r = w.cli("--version", "0.0.9", "--dry-run"); r.code != 0 {
		t.Fatal("a recovered operation blocks the next update:", r.stderr)
	}
}

func TestSignalOutcomeDependsOnThePhase(t *testing.T) {
	for _, c := range []struct {
		name, outcome string
		at            func(w *deploymentFixture, command string, a []string) bool
		ignore        bool
		phases        []string
	}{
		{"verifying", "refused", func(w *deploymentFixture, command string, _ []string) bool { return command == w.verifier }, false, []string{}},
		{"pulling", "failed-before-cutover", func(_ *deploymentFixture, _ string, a []string) bool { return a[0] == "pull" }, false, []string{"prepared", "failed-before-cutover"}},
		// The pull finished; the guard before stopping ends the operation with the panel still running.
		{"before stopping", "failed-before-cutover", func(_ *deploymentFixture, _ string, a []string) bool { return a[0] == "pull" }, true, []string{"prepared", "downloaded", "failed-before-cutover"}},
		// After the cutover the signal fails the running step; recovery runs on its own deadline.
		{"starting target", "recovered", func(w *deploymentFixture, _ string, a []string) bool {
			return a[0] == "compose" && slices.Contains(a, "up") && w.image == w.oldID && !w.running
		}, false, []string{"prepared", "downloaded", "stopping", "backing-up", "starting-target", "recovered"}},
	} {
		t.Run(c.name, func(t *testing.T) {
			w := newDeployment(t)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			w.runner.ignoreContext = c.ignore
			w.hook = func(command string, a []string) {
				if len(a) > 0 && c.at(w, command, a) {
					cancel()
				}
			}
			r := w.cliContext(ctx, "--version", "0.0.9", "--yes")
			result := r.result(t)
			if r.code != 1 || result["outcome"] != c.outcome || !slices.Equal(r.phases(), c.phases) || !strings.HasPrefix(result["error"].(string), "interrupted by a signal: ") {
				t.Fatal(r.code, r.phases(), result)
			}
			if c.outcome == "recovered" {
				if w.image != w.oldID || !w.running {
					t.Fatal("previous deployment not recovered after the signal")
				}
			} else if w.stops != 0 {
				t.Fatal("a signal before the cutover stopped the panel")
			}
		})
	}
}

func TestStatusReadsTheJournalWithoutDockerOrWrites(t *testing.T) {
	dir := t.TempDir()
	state := filepath.Join(dir, ".dockge2")
	must(t, privateDir(state))
	run := &fakeRunner{call: func(c string, a []string) ([]byte, error) {
		t.Fatalf("status ran %s %v", c, a)
		return nil, nil
	}}
	status := func() progressRun {
		var stdout, stderr bytes.Buffer
		code := cli(context.Background(), []string{"--dir", dir, "--verifier", filepath.Join(state, "bin", "cosign"), "--update", "--progress", "json", "--status"}, &stdout, &stderr, &engine{run: run})
		return parseProgress(t, code, stdout.String(), stderr.String())
	}
	if r := status(); r.code != 0 || r.stdout != "" {
		t.Fatal("status without a journal printed", r.stdout)
	}
	op := operation{ID: "20260925T101500.000000000", Phase: "recovery-required", Previous: &installed{Version: "0.0.8"}, Target: installed{Version: "0.0.9"}, Error: "pull from https://robot:s3cr3t@registry.example/v2 failed\nfull command output"}
	must(t, writeJSON(filepath.Join(state, "operation.json"), op))
	must(t, os.Chmod(state, 0500))
	t.Cleanup(func() { _ = os.Chmod(state, 0700) })
	r := status()
	want := `{"dockge2":"journal","v":1,"op":"20260925T101500.000000000","phase":"recovery-required","from":"0.0.8","to":"0.0.9","error":"pull from https://[REDACTED]@registry.example/v2 failed"}` + "\n"
	if r.code != 0 || r.stdout != want || len(run.calls) != 0 {
		t.Fatal(r.code, r.stdout, r.stderr)
	}
	// Only a recovered journal states whether the data was restored; false is a fact too.
	op.Phase, op.Error = "recovered", ""
	must(t, os.Chmod(state, 0700))
	must(t, writeJSON(filepath.Join(state, "operation.json"), op))
	if r = status(); !strings.HasSuffix(r.stdout, `"to":"0.0.9","restoredData":false}`+"\n") {
		t.Fatal(r.stdout)
	}
}

func TestPublicErrorsAreRedactedSingleLineAndBounded(t *testing.T) {
	pull := &commandError{base: "docker", name: "docker pull", err: errors.New("exit status 1"), detail: "Using default tag\nError response from daemon: Head \"https://robot:s3cr3t@registry.example/v2/panel\": denied"}
	got := publicError(fmt.Errorf("update failed and previous deployment was recovered: %w", pull))
	if got != `update failed and previous deployment was recovered: docker pull failed: exit status 1: Error response from daemon: Head "https://[REDACTED]@registry.example/v2/panel": denied` {
		t.Fatal(got)
	}
	// Compose output can quote interpolated values, so only the step reaches the panel.
	compose := &commandError{base: "docker", name: "docker compose", err: errors.New("exit status 1"), detail: "invalid interpolation: SECRET=cost$5"}
	got = publicError(fmt.Errorf("update failed (%w); recovery failed: %w", errors.New("candidate crashed"), compose))
	if got != "update failed (candidate crashed); recovery failed: docker compose failed: exit status 1" {
		t.Fatal(got)
	}
	if got = publicError(errors.New("token=abc123\n\tsecond   line")); got != "token=[REDACTED] second line" {
		t.Fatal(got)
	}
	got = publicError(errors.New(strings.Repeat("é", 800)))
	if utf8.RuneCountInString(got) != maxErrorLength || !strings.HasSuffix(got, "...") {
		t.Fatal(utf8.RuneCountInString(got))
	}
	// A real command failure keeps its human text and loses its output only in public.
	_, err := commandRunner{}.run(context.Background(), "sh", "-c", "echo first >&2; echo last line >&2; exit 3")
	if err == nil || err.Error() != "sh failed: exit status 3\nfirst\nlast line" || publicError(err) != "sh failed: exit status 3: last line" {
		t.Fatal(err)
	}
	out, err := commandRunner{}.runEnv(context.Background(), []string{"DOCKGE2_TEST_VALUE=from-env"}, "sh", "-c", `printf %s "$DOCKGE2_TEST_VALUE"`)
	if err != nil || string(out) != "from-env" {
		t.Fatal(string(out), err)
	}
}

func TestOtherWritersIgnoreReadOnlyBinds(t *testing.T) {
	for _, c := range []struct {
		name, mounts, data, refusal string
	}{
		// The update helper: the installation and the data read-only, state, /tmp and the socket writable.
		{"update helper", `[{"Type":"bind","Source":"/srv/panel","RW":false},{"Type":"bind","Source":"/srv/panel/data","RW":false},{"Type":"bind","Source":"/srv/panel/.dockge2","RW":true},{"Type":"bind","Source":"/tmp","RW":true},{"Type":"bind","Source":"/var/run/docker.sock","RW":true}]`, "/srv/panel/data", ""},
		{"named volume", `[{"Type":"volume","Source":"/srv/panel/data","RW":true}]`, "/srv/panel/data", ""},
		{"writable parent", `[{"Type":"bind","Source":"/srv/panel","RW":true}]`, "/srv/panel/data", "another running container"},
		{"data under /tmp", `[{"Type":"bind","Source":"/tmp","RW":true}]`, "/tmp/panel-data", "under /tmp is not supported"},
		{"read-only /tmp", `[{"Type":"bind","Source":"/tmp","RW":false}]`, "/tmp/panel-data", ""},
	} {
		t.Run(c.name, func(t *testing.T) {
			run := &fakeRunner{call: func(_ string, a []string) ([]byte, error) {
				if a[0] == "ps" {
					return []byte("own\nhelper"), nil
				}
				if !slices.Equal(a[len(a)-1:], []string{"helper"}) {
					t.Fatal(a)
				}
				return []byte(c.mounts), nil
			}}
			err := docker{run: run}.otherWriters(context.Background(), "own", c.data)
			if c.refusal == "" && err != nil || c.refusal != "" && (err == nil || !strings.Contains(err.Error(), c.refusal)) {
				t.Fatal(err)
			}
		})
	}
}

// restoreLayout is an installation with a recorded snapshot of operation id.
func restoreLayout(t *testing.T) (dir, data, snapshot, id string) {
	t.Helper()
	dir, err := filepath.EvalSymlinks(t.TempDir())
	must(t, err)
	id = "20260925T101500.000000000"
	data = filepath.Join(dir, "data")
	snapshot = filepath.Join(dir, ".dockge2", "operations", id, "data-backup")
	must(t, os.MkdirAll(snapshot, 0700))
	must(t, os.WriteFile(filepath.Join(snapshot, "dockge.db"), []byte("snapshot"), 0600))
	must(t, recordSnapshot(snapshot))
	must(t, os.Mkdir(data, 0700))
	must(t, os.WriteFile(filepath.Join(data, "dockge.db"), []byte("newer"), 0600))
	return dir, data, snapshot, id
}

func TestRestoreAcceptsOnlyTheRecordedLayout(t *testing.T) {
	dir, data, snapshot, id := restoreLayout(t)
	must(t, validateRestore(data, snapshot, id))
	alias := filepath.Join(dir, "alias")
	must(t, os.Symlink(data, alias))
	for name, c := range map[string][3]string{
		"operation id":    {data, snapshot, "../" + id},
		"relative":        {"data", snapshot, id},
		"unclean":         {dir + "/./data", snapshot, id},
		"mount syntax":    {data + ",readonly", snapshot, id},
		"under root":      {"/data", "/.dockge2/operations/" + id + "/data-backup", id},
		"other operation": {data, filepath.Join(dir, ".dockge2", "operations", "20260101T000000.000000000", "data-backup"), id},
		"not a snapshot":  {data, filepath.Join(dir, ".dockge2", "operations", id, "release"), id},
		"inside state":    {filepath.Join(dir, ".dockge2", "data"), snapshot, id},
		"symlink":         {alias, snapshot, id},
	} {
		if validateRestore(c[0], c[1], c[2]) == nil {
			t.Fatal("restore accepted:", name)
		}
	}
}

func TestRestoreDataKeepsNewerDataAndFinishesAnInterruptedRun(t *testing.T) {
	_, data, snapshot, id := restoreLayout(t)
	failed := failedDataDir(data, id)
	must(t, restoreData(context.Background(), data, snapshot, id))
	if readData(t, data) != "snapshot" || readData(t, failed) != "newer" {
		t.Fatal("restore did not swap the directories")
	}
	// A repeat never overwrites the preserved data.
	must(t, os.WriteFile(filepath.Join(data, "dockge.db"), []byte("written after the restore"), 0600))
	must(t, restoreData(context.Background(), data, snapshot, id))
	if readData(t, failed) != "newer" || readData(t, data) != "written after the restore" {
		t.Fatal("repeated restore replaced data")
	}
	// Interrupted between the two renames: the staged copy becomes the data.
	must(t, os.Rename(data, data+".dockge-restore-"+id))
	must(t, restoreData(context.Background(), data, snapshot, id))
	if readData(t, data) != "written after the restore" || exists(data+".dockge-restore-"+id) {
		t.Fatal("interrupted restore not finished")
	}
	_, data, snapshot, id = restoreLayout(t)
	must(t, os.WriteFile(filepath.Join(snapshot, "dockge.db"), []byte("corrupted"), 0600))
	if restoreData(context.Background(), data, snapshot, id) == nil || readData(t, data) != "newer" || exists(failedDataDir(data, id)) {
		t.Fatal("corrupted snapshot touched the data")
	}
}

func TestInternalRestoreIsNotAnOption(t *testing.T) {
	_, data, snapshot, id := restoreLayout(t)
	var o options
	f := flags(&o)
	var usage bytes.Buffer
	f.SetOutput(&usage)
	f.PrintDefaults()
	if f.Lookup(strings.TrimPrefix(internalRestoreFlag, "--")) != nil || strings.Contains(usage.String(), "internal") || !strings.Contains(usage.String(), "-restore-on-failed-start") {
		t.Fatal(usage.String())
	}
	var stdout, stderr bytes.Buffer
	// Outside its own container, where it is not PID 1, the entrypoint refuses.
	if code := cli(context.Background(), []string{internalRestoreFlag, data, snapshot, id}, &stdout, &stderr, &engine{run: &fakeRunner{}}); code != 2 || readData(t, data) != "newer" {
		t.Fatal(code, stderr.String())
	}
	if code := cli(context.Background(), []string{"--dir", data, internalRestoreFlag, data, snapshot, id}, &stdout, &stderr, &engine{run: &fakeRunner{}}); code != 2 || readData(t, data) != "newer" {
		t.Fatal("internal mode reachable after other arguments")
	}
}

func TestRestoreNeedsAStaticUpdater(t *testing.T) {
	script := filepath.Join(t.TempDir(), "script")
	must(t, os.WriteFile(script, []byte("#!/bin/sh\n"), 0700))
	if staticBinary(script) == nil {
		t.Fatal("script accepted as the updater")
	}
	if f, err := elf.Open("/bin/sh"); err == nil {
		dynamic := false
		for _, p := range f.Progs {
			dynamic = dynamic || p.Type == elf.PT_INTERP
		}
		f.Close()
		if dynamic && staticBinary("/bin/sh") == nil {
			t.Fatal("dynamically linked executable accepted")
		}
	}
	gobin, err := exec.LookPath("go")
	if testing.Short() || err != nil {
		t.Skip("release build check needs the Go toolchain")
	}
	output := filepath.Join(t.TempDir(), "dockge2-update")
	build := exec.Command(gobin, "build", "-trimpath", "-o", output, ".")
	build.Env = append(os.Environ(), "CGO_ENABLED=0")
	if b, err := build.CombinedOutput(); err != nil {
		t.Fatal(string(b))
	}
	must(t, staticBinary(output))
}

func TestVerifierTrustRootLivesInTheState(t *testing.T) {
	r, source := fixture(t)
	run := &fakeRunner{}
	c := newReleaseClient(run, "cosign")
	state := filepath.Join(t.TempDir(), ".dockge2")
	// Before the state exists (fresh installation) Cosign keeps its inherited home.
	must(t, c.persistVerifierRoot(state))
	_, err := c.stage(context.Background(), r.Version, source, filepath.Join(t.TempDir(), "stage"))
	must(t, err)
	must(t, privateDir(state))
	must(t, c.persistVerifierRoot(state))
	_, err = c.stage(context.Background(), r.Version, source, filepath.Join(t.TempDir(), "stage"))
	must(t, err)
	home := filepath.Join(state, "cosign")
	if len(run.envs) != 2 || run.envs[0] != nil || !slices.Equal(run.envs[1], []string{"HOME=" + home, "TUF_ROOT=" + filepath.Join(home, ".sigstore", "root")}) {
		t.Fatal(run.envs)
	}
	info, err := os.Stat(home)
	must(t, err)
	if !info.IsDir() || info.Mode().Perm() != 0700 {
		t.Fatal(info.Mode())
	}
}
