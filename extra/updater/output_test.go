package main

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestHumanTextIsPlainOffATerminal(t *testing.T) {
	w := newDeployment(t)
	code, stdout, stderr := w.invoke(context.Background(), "--version", "0.0.9", "--dry-run")
	if code != 0 || stderr != "" {
		t.Fatal(code, stderr)
	}
	for _, want := range []string{"\nDocker\n  ok       local daemon\n  ok       Engine 28.0.0\n  ok       Compose 2.40.0\n", "\nRelease 0.0.9\n", "\nPlan\n  Action     update 0.0.8 to 0.0.9 (stable)\n", "\nPreview only: "} {
		if !strings.Contains(stdout, want) {
			t.Fatalf("missing %q in:\n%s", want, stdout)
		}
	}
	if strings.Contains(stdout, "\033") {
		t.Fatal("escape codes outside a terminal")
	}
	_, pipe, err := os.Pipe()
	must(t, err)
	defer pipe.Close()
	if paint(pipe, "1", "title") != "title" {
		t.Fatal("a pipe got colour")
	}
}

func TestDockerProblemsNameTheFixAndStopBeforeAnyChange(t *testing.T) {
	cases := map[string]struct {
		change func(*deploymentFixture)
		want   []string
	}{
		"no compose plugin": {func(w *deploymentFixture) { w.noCompose = true }, []string{"  failed   Docker Compose\n", "'compose' is not a docker command", "Install the Docker Compose plugin"}},
		"old engine":        {func(w *deploymentFixture) { w.engineVersion = "20.10.24" }, []string{"  failed   Docker requirements\n", "Docker Engine 20.10.24 is older than 24.0.0, which 0.0.9 requires", "Upgrade Docker: "}},
		"old compose":       {func(w *deploymentFixture) { w.composeVersion = "v2.17.3" }, []string{"Docker Compose 2.17.3 is older than 2.20.0"}},
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			w := newDeployment(t)
			c.change(w)
			code, _, stderr := w.invoke(context.Background(), "--version", "0.0.9", "--dry-run")
			if code != 1 {
				t.Fatal(code)
			}
			for _, want := range append(c.want, "\nStopped before any change.\n") {
				if !strings.Contains(stderr, want) {
					t.Fatalf("missing %q in:\n%s", want, stderr)
				}
			}
		})
	}
	// A distribution suffix does not make a new enough Engine old.
	w := newDeployment(t)
	w.engineVersion = "24.0.7-0ubuntu4"
	if code, _, stderr := w.invoke(context.Background(), "--version", "0.0.9", "--dry-run"); code != 0 {
		t.Fatal(stderr)
	}
}

func TestRecoveredUpdatePrintsTheFailureOnce(t *testing.T) {
	w := newDeployment(t)
	w.startFailure = "target exited"
	code, stdout, stderr := w.invoke(context.Background(), "--version", "0.0.9", "--yes")
	if code != 1 {
		t.Fatal(code)
	}
	if strings.Count(stderr, "target exited") != 1 || !strings.Contains(stderr, "  failed   starting 0.0.9\n           target exited\n") {
		t.Fatalf("failure not reported once:\n%s", stderr)
	}
	if !strings.Contains(stdout, "\nRecovery\n  ok       0.0.9 stopped\n  ok       0.0.8 started\n  ok       0.0.8 is healthy\n") {
		t.Fatal(stdout)
	}
	if !strings.HasSuffix(stderr, "\nThe update failed; 0.0.8 is running again.\n") {
		t.Fatal(stderr)
	}
}

func TestFreshInstallationSaysWhereToSignIn(t *testing.T) {
	w := newDeployment(t)
	for _, p := range []string{filepath.Join(w.state, "active.json"), filepath.Join(w.dir, ".env"), filepath.Join(w.data, "dockge.db")} {
		must(t, os.Remove(p))
	}
	w.containerID, w.running, w.port = "", false, "5001"
	token := filepath.Join(w.data, "bootstrap-token")
	w.hook = func(command string, a []string) {
		if command == "docker" && strings.Contains(" "+strings.Join(a, " ")+" ", " up ") {
			must(t, os.WriteFile(token, []byte("invented-setup-code"), 0600))
		}
	}
	var stdout, stderr bytes.Buffer
	args := []string{"--dir", w.dir, "--verifier", w.verifier, "--release-dir", w.assets, "--version", "0.0.9", "--stacks-dir", filepath.Join(w.dir, "stacks"), "--yes"}
	if code := cli(context.Background(), args, &stdout, &stderr, w.engine(nil)); code != 0 {
		t.Fatal(code, stderr.String())
	}
	out := stdout.String()
	for _, want := range []string{"  Action     install 0.0.9 (stable)\n", "\nInstalling 0.0.9\n", "  ok       configuration written to ", "\nDone\n  Dockge2 0.0.9 is running.\n", "  Open       http://SERVER:5001\n", "  Setup code " + asRoot() + "cat " + token + "\n", "  Updates    " + launcher(w.dir) + " --dry-run\n"} {
		if !strings.Contains(out, want) {
			t.Fatalf("missing %q in:\n%s", want, out)
		}
	}
	if strings.Contains(out, "invented-setup-code") || strings.Contains(out, "Rollback") {
		t.Fatal(out)
	}
}
