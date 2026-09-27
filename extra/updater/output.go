package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

// The human text is sections: a bold title, then lines with "ok", "failed" or "warning" in
// a column, details under the text, and fields for a plan. Colour, and a running step that
// its result overwrites, are for a terminal without NO_COLOR only.

const statusWidth, fieldWidth = 7, 11

var detailIndent = strings.Repeat(" ", 2+statusWidth+2)

func terminal(w io.Writer) bool {
	f, ok := w.(*os.File)
	if !ok || os.Getenv("NO_COLOR") != "" || os.Getenv("TERM") == "dumb" {
		return false
	}
	info, err := f.Stat()
	return err == nil && info.Mode()&os.ModeCharDevice != 0
}
func paint(w io.Writer, code, s string) string {
	if !terminal(w) {
		return s
	}
	return "\033[" + code + "m" + s + "\033[0m"
}
func mark(w io.Writer, status, code, text string) {
	fmt.Fprintf(w, "  %s  %s\n", paint(w, code, fmt.Sprintf("%-*s", statusWidth, status)), text)
}
func details(w io.Writer, text string) {
	for _, line := range strings.Split(strings.TrimSpace(text), "\n") {
		fmt.Fprintln(w, strings.TrimRight(detailIndent+line, " "))
	}
}

// hinted carries advice for the person at the terminal. The panel's result line gets the
// error alone.
type hinted struct {
	err  error
	hint []string
}

func (h *hinted) Error() string { return h.err.Error() }
func (h *hinted) Unwrap() error { return h.err }
func withHint(err error, hint ...string) error {
	return &hinted{err: err, hint: hint}
}

func (e *engine) human() io.Writer {
	if e.out == nil {
		return io.Discard
	}
	return e.out
}
func (e *engine) failures() io.Writer {
	if e.errOut != nil {
		return e.errOut
	}
	return e.human()
}

// settle erases the running step from a terminal before anything else is printed.
func (e *engine) settle() {
	if e.running != "" && terminal(e.human()) {
		fmt.Fprint(e.human(), "\r\033[K")
	}
	e.running = ""
}
func (e *engine) section(title string) {
	e.settle()
	e.sections++
	fmt.Fprintf(e.human(), "\n%s\n", paint(e.human(), "1", title))
}

// begin names the step under way; a failure is reported as this step.
func (e *engine) begin(step string) {
	e.settle()
	e.running = step
	if w := e.human(); terminal(w) {
		fmt.Fprintf(w, "  %s  %s", paint(w, "2", fmt.Sprintf("%-*s", statusWidth, "...")), step)
	}
}
func (e *engine) ok(text string) {
	e.settle()
	mark(e.human(), "ok", "32", text)
}
func (e *engine) warn(text string) {
	e.settle()
	mark(e.failures(), "warning", "33", text)
}
func (e *engine) field(name, value string) {
	e.settle()
	fmt.Fprintf(e.human(), "  %-*s%s\n", fieldWidth, name, value)
}
func (e *engine) note(text string) {
	e.settle()
	fmt.Fprintln(e.human(), "  "+text)
}
func (e *engine) closing(lines ...string) {
	e.settle()
	fmt.Fprintln(e.human())
	for _, line := range lines {
		fmt.Fprintln(e.human(), line)
	}
}

// fail prints a failure: the running step, or else the first line of the error, then the
// rest of the error and its hint.
func (e *engine) fail(err error) {
	step := e.running
	e.settle()
	w := e.failures()
	text := strings.ReplaceAll(redact(err.Error()), context.Canceled.Error(), "interrupted by a signal")
	if step == "" {
		step, text, _ = strings.Cut(text, "\n")
	}
	mark(w, "failed", "31", step)
	if strings.TrimSpace(text) != "" {
		details(w, text)
	}
	var h *hinted
	if errors.As(err, &h) {
		for _, line := range h.hint {
			fmt.Fprintln(w, detailIndent+line)
		}
	}
}

// failed ends a run that returned an error: the failure, unless recovery already printed
// it, and where that leaves the installation.
func (e *engine) failed(o options, err error) {
	if o.status {
		fmt.Fprintln(e.failures(), redact(err.Error()))
		return
	}
	if errors.Is(err, errDeclined) {
		e.closing("Cancelled: nothing was installed or changed.")
		return
	}
	if !e.reported {
		if e.sections == 0 {
			switch {
			case o.rollback:
				e.section("Rollback")
			case o.resume:
				e.section("Resume")
			default:
				e.section("Installation")
			}
		}
		e.fail(err)
	}
	summary := "Stopped before any change."
	switch e.report.phase {
	case "":
	case "failed-before-cutover":
		summary = "Stopped before cutover: the running panel was not stopped."
		if e.report.from == "" {
			summary = "Stopped before the panel was started."
		}
	case "recovered":
		summary = "The update failed; " + e.report.from + " is running again."
		if e.report.restoredData {
			summary = "The update failed; " + e.report.from + " is running again on the data copy."
		}
	case "recovery-required":
		summary = "Recovery did not finish. See the journal: " + launcher(o.dir) + " --status"
		if e.report.from == "" {
			summary = "The installation did not finish. See the journal: " + launcher(o.dir) + " --status"
		}
	default:
		summary = "The operation stopped in the " + e.report.phase + " phase. See the journal: " + launcher(o.dir) + " --status"
	}
	fmt.Fprintf(e.failures(), "\n%s\n", summary)
}

// launcher is how to call the installed updater from a shell: a root shell needs no sudo.
func launcher(dir string) string {
	if abs, err := filepath.Abs(dir); err == nil {
		dir = abs
	}
	return asRoot() + filepath.Join(dir, ".dockge2", "update")
}
func asRoot() string {
	if os.Geteuid() == 0 && os.Getenv("SUDO_USER") == "" {
		return ""
	}
	return "sudo "
}
func shortID(id string) string {
	id = strings.TrimPrefix(id, "sha256:")
	if len(id) > 12 {
		id = id[:12]
	}
	return id
}

// checkDocker is the Docker section: a local daemon, its Engine and Compose versions, which
// the release requirements are compared with, and how this Compose renders binds.
func (e *engine) checkDocker(ctx context.Context, d *docker, probeDir string) (string, error) {
	daemon, err := e.dockerDaemon(ctx, *d)
	if err != nil {
		return "", err
	}
	e.begin("Docker Engine")
	output, err := d.command(ctx, "version", "--format", "{{.Server.Version}}")
	if err != nil {
		return "", err
	}
	e.engineVersion = strings.TrimPrefix(strings.TrimSpace(string(output)), "v")
	e.ok("Engine " + e.engineVersion)
	e.begin("Docker Compose")
	output, err = d.command(ctx, "compose", "version", "--short")
	if err != nil {
		return "", withHint(err, "Install the Docker Compose plugin, then run this again:", "https://docs.docker.com/compose/install/linux/")
	}
	e.composeVersion = strings.TrimPrefix(strings.TrimSpace(string(output)), "v")
	e.ok("Compose " + e.composeVersion)
	e.begin("how Compose renders bind mounts")
	if d.createHostPath, err = d.omittedCreateHostPath(ctx, probeDir); err != nil {
		return "", err
	}
	e.settle()
	return daemon, nil
}
func (e *engine) dockerDaemon(ctx context.Context, d docker) (string, error) {
	e.section("Docker")
	e.begin("local daemon")
	daemon, err := d.localDaemon(ctx)
	if err != nil {
		text := err.Error()
		switch {
		case strings.Contains(text, "permission denied"):
			return "", withHint(err, "Run this as root, for example with sudo.")
		case strings.Contains(text, "Cannot connect to the Docker daemon"):
			return "", withHint(err, "Start Docker, for example: systemctl start docker")
		}
		return "", err
	}
	e.ok("local daemon")
	return daemon, nil
}

// checkVersions compares the versions of the Docker section with the verified release.
func (e *engine) checkVersions(r Release) error {
	e.begin("Docker requirements")
	for _, item := range []struct{ name, value, minimum string }{{"Engine", e.engineVersion, r.MinEngine}, {"Compose", e.composeVersion, r.MinCompose}} {
		// Vendor suffixes do not change the underlying Engine/Compose feature level.
		value := strings.Split(strings.Split(item.value, "+")[0], "-")[0]
		if !versionPattern.MatchString(value) || compareVersion(value, item.minimum) < 0 {
			return withHint(fmt.Errorf("Docker %s %s is older than %s, which %s requires", item.name, item.value, item.minimum, r.Version),
				"Upgrade Docker: https://docs.docker.com/engine/install/")
		}
	}
	e.ok("Docker is new enough: Engine " + r.MinEngine + "+, Compose " + r.MinCompose + "+")
	return nil
}

// plan prints what an installation or update is about to do.
func (e *engine) plan(o options, r Release, active *installed, project, data string, c composeConfig, fields []string) {
	switch {
	case active == nil:
		e.field("Action", "install "+r.Version+" ("+r.Channel+")")
	case active.Version == r.Version:
		e.field("Action", "re-apply "+r.Version+" ("+r.Channel+")")
	default:
		e.field("Action", "update "+active.Version+" to "+r.Version+" ("+r.Channel+")")
	}
	if active != nil {
		e.field("Current", active.Version+", image "+shortID(active.ImageID))
	}
	e.field("Directory", o.dir)
	e.field("Project", project)
	e.field("Data", data)
	if v := c.env("DOCKGE_STACKS_DIR"); v != "" {
		e.field("Stacks", v)
	}
	if v := c.env("DOCKGE_PORT"); v != "" {
		e.field("Port", v)
	}
	if len(fields) > 0 {
		e.field("Changes", strings.Join(fields, ", ")+" (values hidden)")
	}
	if active != nil {
		e.note("Before the new version starts, the data is copied with the panel stopped.")
		if active.Schema != r.Schema {
			e.note("The database schema changes: a rollback after the start needs --restore-data.")
		}
		e.note("Stack containers are not restarted.")
	}
}

// finish is the Done section of an installation or update.
func (e *engine) finish(o options, r Release, previous *installed, data string, c composeConfig) {
	e.section("Done")
	if previous == nil {
		e.note("Dockge2 " + r.Version + " is running.")
		if port := c.env("DOCKGE_PORT"); port != "" {
			e.field("Open", "http://SERVER:"+port)
		}
		if token := filepath.Join(data, "bootstrap-token"); exists(token) {
			e.field("Setup code", asRoot()+"cat "+token)
		}
		e.field("Updates", launcher(o.dir)+" --dry-run")
		e.note("The installer does not open firewall ports or set up HTTPS.")
		return
	}
	e.note("Dockge2 " + r.Version + " is running; " + previous.Version + " is kept for a rollback.")
	rollback := launcher(o.dir) + " --rollback"
	if previous.Schema != r.Schema {
		rollback += " --restore-data"
	}
	e.field("Rollback", rollback)
}
