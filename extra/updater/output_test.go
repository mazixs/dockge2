package main

import (
	"bytes"
	"context"
	"io"
	"net"
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
	null, err := os.OpenFile(os.DevNull, os.O_WRONLY, 0)
	must(t, err)
	defer null.Close()
	if tty(pipe) || tty(null) {
		t.Fatal("a pipe or /dev/null taken for a terminal")
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
	for _, c := range []struct {
		name      string
		addresses []string
		tty       bool
		want, not []string
	}{
		{"captured output", []string{"198.51.100.7", "[2001:db8::7]"}, false,
			[]string{"  Open       http://198.51.100.7:5001\n             http://[2001:db8::7]:5001\n  Setup code " + asRoot() + "cat "},
			[]string{"invented-setup-code", "public address"}},
		{"a terminal", []string{"192.168.1.20"}, true,
			[]string{"  Open       http://192.168.1.20:5001\n             from outside this network, use the host's public address\n", "  Setup code invented-setup-code\n             for the owner account, once; also in "},
			nil},
		{"no address found", nil, false, []string{"  Open       http://SERVER:5001\n"}, nil},
	} {
		t.Run(c.name, func(t *testing.T) {
			w := newDeployment(t)
			for _, p := range []string{filepath.Join(w.state, "active.json"), filepath.Join(w.dir, ".env"), filepath.Join(w.data, "dockge.db")} {
				must(t, os.Remove(p))
			}
			w.containerID, w.running, w.port = "", false, "5001"
			token := filepath.Join(w.data, "bootstrap-token")
			w.hook = func(command string, a []string) {
				if command == "docker" && strings.Contains(" "+strings.Join(a, " ")+" ", " up ") {
					must(t, os.WriteFile(token, []byte("invented-setup-code\n"), 0600))
				}
			}
			e := w.engine(nil)
			e.addresses = func() []string { return c.addresses }
			e.onTTY = func(io.Writer) bool { return c.tty }
			var stdout, stderr bytes.Buffer
			args := []string{"--dir", w.dir, "--verifier", w.verifier, "--release-dir", w.assets, "--version", "0.0.9", "--stacks-dir", filepath.Join(w.dir, "stacks"), "--yes"}
			if code := cli(context.Background(), args, &stdout, &stderr, e); code != 0 {
				t.Fatal(code, stderr.String())
			}
			out := stdout.String()
			for _, want := range append(c.want, "  Action     install 0.0.9 (stable)\n", "\nInstalling 0.0.9\n", "  ok       configuration written to ", "\nDone\n  Dockge2 0.0.9 is running.\n", "  Updates    "+launcher(w.dir)+" --dry-run\n") {
				if !strings.Contains(out, want) {
					t.Fatalf("missing %q in:\n%s", want, out)
				}
			}
			for _, not := range append(c.not, "Rollback") {
				if strings.Contains(out, not) {
					t.Fatalf("unexpected %q in:\n%s", not, out)
				}
			}
		})
	}
}

func TestHostAddressesLeaveOutWhatIsNotReachable(t *testing.T) {
	addresses := hostAddresses()
	if len(addresses) > 3 {
		t.Fatal(addresses)
	}
	for _, a := range addresses {
		ip := net.ParseIP(strings.Trim(a, "[]"))
		if ip == nil || ip.IsLoopback() || ip.IsLinkLocalUnicast() {
			t.Fatal(a)
		}
	}
	if !bridge("docker0") || !bridge("br-1a2b3c") || !bridge("veth9f8e") || bridge("eth0") || bridge("ens3") {
		t.Fatal("bridge names")
	}
}

func TestADeclinedQuestionIsACancellationNotAFailure(t *testing.T) {
	var stdout, stderr bytes.Buffer
	e := &engine{out: &stdout, errOut: &stderr}
	e.failed(options{}, errDeclined)
	if stdout.String() != "\nCancelled: nothing was installed or changed.\n" || stderr.Len() != 0 {
		t.Fatalf("%q %q", stdout.String(), stderr.String())
	}
}
