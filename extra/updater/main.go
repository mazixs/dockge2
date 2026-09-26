// Dockge2's host-side updater. It has no Node/Python runtime dependency.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"time"
)

type stringsFlag []string

func (s *stringsFlag) String() string     { return strings.Join(*s, ",") }
func (s *stringsFlag) Set(v string) error { *s = append(*s, v); return nil }

type options struct {
	dir, version, image, project, verifier, releaseDir, dataDir, stacksDir, ref, composeFile, progress string
	port                                                                                               int
	update, dryRun, yes, rollback, restoreData, development, resume, status, restoreOnFailedStart      bool
	overrides                                                                                          stringsFlag
}

func flags(o *options) *flag.FlagSet {
	f := flag.NewFlagSet("dockge2-update", flag.ContinueOnError)
	f.StringVar(&o.dir, "dir", ".", "Installation directory")
	f.StringVar(&o.version, "version", "", "Exact release version; otherwise retain the selected channel")
	f.StringVar(&o.image, "image", "", "Explicit image source/channel change")
	f.StringVar(&o.composeFile, "compose-file", "docker-compose.yml", "Explicit released base file for legacy import")
	f.StringVar(&o.project, "project", "", "Explicit Compose project name")
	f.StringVar(&o.verifier, "verifier", "cosign", "Trusted Cosign verifier")
	f.StringVar(&o.releaseDir, "release-dir", "", "Local signed release directory (verification is mandatory)")
	f.StringVar(&o.dataDir, "data-dir", "", "Data directory for a fresh installation")
	f.StringVar(&o.stacksDir, "stacks-dir", "/opt/stacks", "Stack directory for a fresh installation")
	f.IntVar(&o.port, "port", 5001, "Port for a fresh installation")
	f.BoolVar(&o.update, "update", false, "Update or import an existing installation")
	f.BoolVar(&o.dryRun, "dry-run", false, "Show a preview without changing the installation or pulling an image")
	f.BoolVar(&o.yes, "yes", false, "Accept the displayed update and maintenance outage")
	f.BoolVar(&o.resume, "resume", false, "Retry the recorded target after an interrupted cutover")
	f.BoolVar(&o.status, "status", false, "Show the operation journal without contacting Docker")
	f.BoolVar(&o.rollback, "rollback", false, "Restore the recorded previous deployment")
	f.BoolVar(&o.restoreData, "restore-data", false, "Explicitly restore the stopped panel's data snapshot during rollback")
	f.BoolVar(&o.development, "development", false, "Explicitly build a development source ref")
	f.StringVar(&o.ref, "ref", "", "Development source branch, tag or commit")
	f.Var(&o.overrides, "compose-override", "Explicit local override file (repeatable)")
	f.StringVar(&o.progress, "progress", "", "Machine-readable progress on stdout, human text on stderr: json")
	f.BoolVar(&o.restoreOnFailedStart, "restore-on-failed-start", false, "If the target never becomes ready after a schema change, restore the verified data snapshot and the previous deployment")
	return f
}

func arguments(args []string) (options, error) {
	var o options
	f := flags(&o)
	if err := f.Parse(args); err != nil {
		return o, err
	}
	if len(f.Args()) != 0 {
		return o, errors.New("unexpected positional arguments")
	}
	if (o.resume && o.rollback) || (o.status && (o.resume || o.rollback)) {
		return o, errors.New("choose only one of --resume, --rollback or --status")
	}
	if o.restoreData && !o.rollback {
		return o, errors.New("--restore-data requires --rollback")
	}
	if o.development != (o.ref != "") {
		return o, errors.New("development builds require both --development and --ref")
	}
	if (o.rollback || o.resume) && (o.development || o.image != "" || o.version != "") {
		return o, errors.New("recovery uses the recorded source; --resume and --rollback cannot change it")
	}
	if o.port < 1 || o.port > 65535 {
		return o, errors.New("invalid port")
	}
	if o.progress != "" && o.progress != "json" {
		return o, errors.New("--progress accepts only json")
	}
	if o.progress != "" && (o.rollback || o.resume) {
		return o, errors.New("--progress reports updates, dry runs and --status only")
	}
	if o.restoreOnFailedStart && (!o.update || !o.yes || o.dryRun || o.rollback || o.resume || o.status) {
		return o, errors.New("--restore-on-failed-start applies only to --update --yes")
	}
	return o, nil
}

type installed struct {
	Version    string   `json:"version"`
	Schema     string   `json:"schema"`
	ImageID    string   `json:"imageId"`
	Digest     string   `json:"digest"`
	Source     string   `json:"source"`
	Project    string   `json:"project"`
	DataDir    string   `json:"dataDir"`
	Config     string   `json:"config"`
	ReleaseDir string   `json:"releaseDir"`
	Overrides  []string `json:"overrides"`
	Mode       string   `json:"mode"`
}
type operation struct {
	ID             string     `json:"id"`
	Phase          string     `json:"phase"`
	Previous       *installed `json:"previous,omitempty"`
	Target         installed  `json:"target"`
	Backup         string     `json:"backup,omitempty"`
	BackupVerified bool       `json:"backupVerified"`
	RestoreData    bool       `json:"restoreData"`
	Error          string     `json:"error,omitempty"`
}
type engine struct {
	run       runner
	out       io.Writer // human text
	progress  io.Writer // JSON lines; nil without --progress json
	devSource string
	binary    func() (string, error) // the updater executable; tests replace it
	report    report
}

func main() {
	// After the first signal later ones are absorbed, so recovery cannot be interrupted.
	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	code := cli(ctx, os.Args[1:], os.Stdout, os.Stderr, &engine{run: commandRunner{}})
	cancel()
	os.Exit(code)
}
func (e *engine) message(s string) { fmt.Fprintln(e.out, s) }
func loadInstalled(path string) (*installed, error) {
	data, err := readRegular(path, maxMetadata)
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var value installed
	if err = decodeStrict(data, &value); err != nil {
		return nil, err
	}
	return &value, nil
}
func selectedVersion(explicit, source string) (string, error) {
	if explicit != "" {
		v := strings.TrimPrefix(explicit, "v")
		if !versionPattern.MatchString(v) {
			return "", errors.New("invalid version")
		}
		return v, nil
	}
	if strings.Contains(source, "@") {
		return "", errors.New("a digest source requires its exact --version and signed release metadata")
	}
	tag := "latest"
	if i := strings.LastIndex(source, ":"); i > strings.LastIndex(source, "/") {
		tag = source[i+1:]
	}
	if tag == "latest" {
		return "", nil
	}
	if !versionPattern.MatchString(tag) {
		return "", errors.New("this channel needs an explicit release --version; source will not be changed")
	}
	return tag, nil
}
func imageRepository(source string) (string, error) {
	value := strings.Split(source, "@")[0]
	if i := strings.LastIndex(value, ":"); i > strings.LastIndex(value, "/") {
		value = value[:i]
	}
	if !imagePattern.MatchString(value) {
		return "", errors.New("local/custom image needs an explicit published --image source or development mode")
	}
	return value, nil
}
func approved(yes bool) error {
	if yes {
		return nil
	}
	fmt.Fprint(os.Stderr, "Continue with this release and a panel maintenance outage? [y/N]: ")
	f, err := os.OpenFile("/dev/tty", os.O_RDWR, 0)
	if err != nil {
		return errors.New("no terminal; review --dry-run and use --yes to apply")
	}
	defer f.Close()
	var answer string
	if _, err = fmt.Fscanln(f, &answer); err != nil {
		return errors.New("update cancelled before cutover")
	}
	if answer != "y" && answer != "Y" {
		return errors.New("update cancelled before cutover")
	}
	return nil
}
func exists(path string) bool { _, err := os.Lstat(path); return err == nil }
func (e *engine) execute(ctx context.Context, o options) error {
	abs, err := canonicalPath(o.dir)
	if err != nil {
		return err
	}
	// Existing deployments must resolve to one directory even through a symlink.
	if exists(abs) {
		abs, err = filepath.EvalSymlinks(abs)
		if err != nil {
			return err
		}
	}
	o.dir = abs
	state := filepath.Join(o.dir, ".dockge2")
	if o.status && e.progress != nil {
		return e.statusLine(state)
	}
	journalBefore, _ := os.ReadFile(filepath.Join(state, "operation.json"))
	active, err := loadInstalled(filepath.Join(state, "active.json"))
	if err != nil {
		return err
	}
	if active != nil {
		e.report.from = active.Version
	}
	if active != nil && o.project == "" {
		o.project = active.Project
	}
	if active != nil && len(o.overrides) == 0 {
		o.overrides = active.Overrides
	}
	for i := range o.overrides {
		o.overrides[i], err = filepath.Abs(o.overrides[i])
		if err != nil {
			return err
		}
	}
	if o.status {
		b, err := readRegular(filepath.Join(state, "operation.json"), maxMetadata)
		if err != nil {
			return err
		}
		e.message(string(b))
		return nil
	}
	if o.resume {
		return e.resumeOperation(ctx, o, state)
	}
	if o.rollback {
		return e.rollback(ctx, o, state)
	}
	if exists(filepath.Join(state, "operation.json")) {
		data, readErr := readRegular(filepath.Join(state, "operation.json"), maxMetadata)
		if readErr != nil {
			return readErr
		}
		var pending operation
		if err = decodeStrict(data, &pending); err != nil {
			return err
		}
		switch pending.Phase {
		case "success", "recovered", "failed-before-cutover":
		default:
			return fmt.Errorf("operation %s is %s; inspect --status and use --resume or --rollback before another update", pending.ID, pending.Phase)
		}
	}
	if o.update && !exists(filepath.Join(o.dir, ".env")) {
		return errors.New("existing installation .env is required; no defaults will replace it")
	}
	if !o.update && (active != nil || exists(filepath.Join(o.dir, ".env"))) {
		return errors.New("installation already exists; use --update")
	}
	tmp, err := os.MkdirTemp("", "dockge2-candidate-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(tmp)
	env := filepath.Join(o.dir, ".env")
	if !o.update {
		if o.dataDir == "" {
			o.dataDir = filepath.Join(o.dir, "data")
		}
		for _, p := range []string{o.dataDir, o.stacksDir} {
			if !filepath.IsAbs(p) || strings.ContainsAny(p, "\r\n$#'\" ") || p == "/" {
				return errors.New("initial data and stack paths must be absolute, simple non-root paths")
			}
		}
		o.dataDir, err = canonicalPath(o.dataDir)
		if err != nil {
			return err
		}
		o.stacksDir, err = canonicalPath(o.stacksDir)
		if err != nil {
			return err
		}
		env = filepath.Join(tmp, "initial.env")
		initial := fmt.Sprintf("DOCKGE_PORT=%d\nDOCKGE_DATA_DIR=%s\nDOCKGE_STACKS_DIR=%s\nDOCKGE_IMAGE=ghcr.io/mazixs/dockge2:latest\nDOCKGE_ENABLE_CONSOLE=false\n", o.port, o.dataDir, o.stacksDir)
		if err = atomicWrite(env, []byte(initial), 0600); err != nil {
			return err
		}
	}
	d := docker{run: e.run, dir: o.dir, project: o.project}
	daemon, err := d.localDaemon(ctx)
	if err != nil {
		return err
	}
	var current composeConfig
	base := o.composeFile
	if !filepath.IsAbs(base) {
		base = filepath.Join(o.dir, base)
	}
	source := "ghcr.io/mazixs/dockge2:latest"
	if o.update {
		if active != nil {
			base = filepath.Join(active.ReleaseDir, "docker-compose.yml")
		}
		// Do not even evaluate an unrecognized legacy vendor file as Compose.
		// Explicit operator override files are the separate customization boundary.
		vendor, readErr := readRegular(base, maxMetadata)
		if readErr != nil {
			return readErr
		}
		if active == nil && fileHash(vendor) != "baa4b0b12dd7abca6ba22a5f9485013fe80f59cecfb452e79ec6b08b9a033cba" &&
			fileHash(vendor) != "adeb402bd932e0eaf19930bbd5ba3b24e482a2376707c32e03e43645986a187f" {
			return errors.New("legacy Compose base is not a recognized release; preserve edits and supply the matching --compose-file")
		}
		if active != nil {
			b, readErr := readRegular(filepath.Join(active.ReleaseDir, "release.json"), maxMetadata)
			if readErr != nil {
				return readErr
			}
			var prior Release
			if err = decodeStrict(b, &prior); err != nil {
				return err
			}
			if fileHash(vendor) != prior.Assets["docker-compose.yml"].SHA256 {
				return errors.New("managed vendor Compose file was edited")
			}
		}
		current, err = d.config(ctx, base, env, o.overrides)
		if err != nil {
			return err
		}
		d.project = current.Name
		source = current.image()
		if active != nil {
			source = active.Source
		}
	}
	if o.image != "" {
		source = o.image
	}
	if active != nil && active.Mode == "development" && !o.development && o.image == "" {
		return errors.New("development installation requires --development --ref, or an explicit --image change")
	}
	version, err := selectedVersion(o.version, source)
	if err != nil && !o.development {
		return err
	}
	e.report.to = version
	client := newReleaseClient(e.run, o.verifier)
	if err = client.persistVerifierRoot(state); err != nil {
		return err
	}
	stage := filepath.Join(tmp, "release")
	var release Release
	if o.development {
		release, err = e.development(ctx, o, stage)
	} else {
		if version == "" {
			version, err = client.latest(ctx)
			if err != nil {
				return err
			}
		}
		e.message("Verifying release " + version + " and deployment files (no branch checkout).")
		release, err = client.stage(ctx, version, o.releaseDir, stage)
	}
	if err != nil {
		return err
	}
	e.report.to = release.Version
	candidate, err := d.config(ctx, filepath.Join(stage, "docker-compose.yml"), env, o.overrides)
	if err != nil {
		return err
	}
	if d.project == "" {
		d.project = candidate.Name
	}
	if candidate.Name != d.project {
		return errors.New("target changes Compose project identity")
	}
	lock, err := lockProject(daemon, d.project)
	if err != nil {
		return err
	}
	defer lock.Close()
	// Re-check state after acquiring the lock; another invocation may have completed while downloading.
	fresh, err := loadInstalled(filepath.Join(state, "active.json"))
	if err != nil {
		return err
	}
	journalNow, _ := os.ReadFile(filepath.Join(state, "operation.json"))
	if string(journalBefore) != string(journalNow) {
		return errors.New("another operation changed state while preparing; retry")
	}
	a, _ := json.Marshal(active)
	b, _ := json.Marshal(fresh)
	if string(a) != string(b) {
		return errors.New("deployment changed while preparing; retry")
	}
	container, err := d.container(ctx)
	if err != nil {
		return err
	}
	if o.update && container == nil {
		return errors.New("cannot establish the existing panel identity")
	}
	if !o.update && container != nil {
		return errors.New("project already has a panel; use its installation directory")
	}
	dataDir, err := candidate.dataDir()
	if err != nil {
		return err
	}
	if exists(dataDir) {
		canonical, pathErr := filepath.EvalSymlinks(dataDir)
		if pathErr != nil {
			return pathErr
		}
		if canonical != dataDir {
			return errors.New("data path must be canonical, without symlinks")
		}
	}
	for target, mount := range candidate.mountSources() {
		if target != "/app/data" && strings.HasPrefix(mount, "bind:") {
			source := strings.TrimPrefix(mount, "bind:")
			if within(dataDir, source) || within(source, dataDir) {
				return errors.New("panel data must be separate from other mounted directories")
			}
		}
	}
	dataLock, lockErr := lockProject(daemon, "data:"+dataDir)
	if lockErr != nil {
		return lockErr
	}
	defer dataLock.Close()
	if !o.update && exists(dataDir) {
		entries, err := os.ReadDir(dataDir)
		if err != nil {
			return err
		}
		if len(entries) != 0 {
			return errors.New("fresh installation requires an empty data directory; import an existing deployment explicitly")
		}
	}
	self := ""
	if container != nil {
		self = container.ID
	}
	if err = d.otherWriters(ctx, self, dataDir); err != nil {
		return err
	}
	if within(dataDir, state) || within(state, dataDir) {
		return errors.New("data and updater state must be disjoint")
	}
	if o.update {
		active, err = e.validatePrevious(ctx, d, container, current, active, release, base)
		if err != nil {
			return err
		}
		e.report.from = active.Version
		if fresh == nil {
			active.Source = current.image()
		}
		x, _ := json.Marshal(current.mountSources())
		y, _ := json.Marshal(candidate.mountSources())
		if string(x) != string(y) {
			return errors.New("release changes mounts; resolve the configuration explicitly before updating")
		}
		if !o.development && (compareVersion(release.Version, active.Version) < 0 || compareVersion(active.Version, release.MinVersion) < 0) {
			return errors.New("unsupported upgrade path; use recorded rollback for downgrades")
		}
	}
	if err = e.checkVersions(ctx, d, release); err != nil {
		return err
	}
	imageRef := "dockge2-development:" + release.Commit
	if !o.development {
		repo, parseErr := imageRepository(source)
		if parseErr != nil {
			return parseErr
		}
		if strings.Contains(source, "@") && strings.Split(source, "@")[1] != release.Digest {
			return errors.New("requested digest differs from signed release")
		}
		imageRef = repo + "@" + release.Digest
	}
	configBytes, err := configSnapshot(candidate, imageRef)
	if err != nil {
		return err
	}
	fields := []string{}
	if fresh != nil {
		old, readErr := readRegular(fresh.Config, 4<<20)
		if readErr != nil {
			return readErr
		}
		var compareErr error
		fields, compareErr = changedFields(old, configBytes)
		if compareErr != nil {
			return compareErr
		}
		if len(fields) > 0 {
			e.message("Configuration fields changing (values hidden): " + strings.Join(fields, ", "))
		}
	}
	e.message(fmt.Sprintf("Target: %s (%s), project %s. Data: %s. Stack containers are not restarted.", release.Version, release.Channel, d.project, dataDir))
	if active != nil && active.Schema != release.Schema {
		e.message("Schema contract changes; rollback after startup will require explicit --restore-data.")
	}
	if active != nil {
		e.message("Current: " + active.Version + " (" + active.ImageID + "). A stopped-data backup precedes migration.")
	}
	if o.dryRun {
		e.message("Preview only: no image pull, configuration write or container recreation.")
		e.emit(previewLine{Kind: "preview", V: 1, From: e.report.from, To: release.Version, Channel: source, Fields: fields, SchemaChanges: active != nil && active.Schema != release.Schema})
		return nil
	}
	if err = approved(o.yes); err != nil {
		return err
	}
	// A signal before the operation is recorded refuses it; nothing has been written yet.
	if err = ctx.Err(); err != nil {
		return err
	}
	if err = os.MkdirAll(o.dir, 0700); err != nil {
		return err
	}
	if err = privateDir(state); err != nil {
		return err
	}
	id := time.Now().UTC().Format("20060102T150405.000000000")
	opDir := filepath.Join(state, "operations", id)
	if err = privateDir(opDir); err != nil {
		return err
	}
	releaseDir := filepath.Join(opDir, "release")
	if err = copyTree(stage, releaseDir); err != nil {
		return err
	}
	// copyTree creates private regular files; updater executability is explicit.
	binary := filepath.Join(releaseDir, "dockge2-update-linux-"+runtime.GOARCH)
	if err = os.Chmod(binary, 0700); err != nil {
		return err
	}
	targetConfig := filepath.Join(opDir, "target.json")
	if err = atomicWrite(targetConfig, configBytes, 0600); err != nil {
		return err
	}
	if active != nil {
		original, encodeErr := configSnapshot(current, container.Image)
		if fresh != nil {
			original, encodeErr = readRegular(fresh.Config, 4<<20)
			if encodeErr == nil {
				original, encodeErr = pinSnapshot(original, container.Image)
			}
		}
		if encodeErr != nil {
			return encodeErr
		}
		previous := *active
		active = &previous
		active.Config = filepath.Join(opDir, "previous.json")
		active.ImageID = container.Image
		if err = atomicWrite(active.Config, original, 0600); err != nil {
			return err
		}
	}
	mode := "release"
	if o.development {
		mode = "development"
		source = "development@" + release.Commit
	}
	op := operation{ID: id, Phase: "prepared", Previous: active, Target: installed{Version: release.Version, Schema: release.Schema, Digest: release.Digest, Source: source, Project: d.project, DataDir: dataDir, Config: targetConfig, ReleaseDir: releaseDir, Overrides: o.overrides, Mode: mode}}
	save := func(phase string) error {
		op.Phase = phase
		e.message("Update phase: " + phase)
		return e.writeJournal(state, op)
	}
	if err = save("prepared"); err != nil {
		return err
	}
	fail := func(cause error) error {
		op.Error = redact(cause.Error())
		_ = save("failed-before-cutover")
		return cause
	}
	if active != nil {
		if _, err = d.command(ctx, "image", "tag", active.ImageID, "dockge2-recovery:"+strings.ToLower(strings.ReplaceAll(id, ".", "-"))); err != nil {
			return fail(err)
		}
	}
	if o.development {
		if _, err = d.command(ctx, "build", "--file", filepath.Join(e.devSource, "docker/Dockerfile"), "--target", "release", "--tag", imageRef, "--label", "org.opencontainers.image.version="+release.Version, "--label", "org.opencontainers.image.revision="+release.Commit, e.devSource); err != nil {
			return fail(err)
		}
	} else {
		if _, err = d.command(ctx, "pull", imageRef); err != nil {
			return fail(err)
		}
	}
	targetImage, err := d.image(ctx, imageRef)
	if err != nil {
		return fail(err)
	}
	if !o.development && (targetImage.Config.Labels["org.opencontainers.image.revision"] != release.Commit || targetImage.Config.Labels["org.opencontainers.image.version"] != release.Version) {
		return fail(errors.New("downloaded image labels disagree with signed release"))
	}
	if targetImage.Architecture != runtime.GOARCH || targetImage.OS != "linux" {
		return fail(errors.New("image platform differs from this updater platform"))
	}
	op.Target.ImageID = targetImage.ID
	if fresh != nil && active != nil && targetImage.ID == active.ImageID && active.Digest == release.Digest {
		old, readErr := readRegular(fresh.Config, 4<<20)
		if readErr != nil {
			return fail(readErr)
		}
		if string(old) == string(configBytes) {
			if err = e.installLauncher(state, binary, o.verifier, o.dir, o.development); err != nil {
				return fail(err)
			}
			fresh.Source = source
			fresh.Overrides = o.overrides
			if err = writeJSON(filepath.Join(state, "active.json"), fresh); err != nil {
				return fail(err)
			}
			if err = save("success"); err != nil {
				return err
			}
			e.report.noChange = true
			e.message("No change; previous distinct deployment retained.")
			return nil
		}
	}
	if err = save("downloaded"); err != nil {
		return err
	}
	if !o.update {
		if err = os.MkdirAll(dataDir, 0700); err != nil {
			return fail(err)
		}
		if err = os.MkdirAll(o.stacksDir, 0750); err != nil {
			return fail(err)
		}
		initial, readErr := readRegular(env, maxMetadata)
		if readErr != nil {
			return fail(readErr)
		}
		if exists(filepath.Join(o.dir, ".env")) {
			return fail(errors.New("configuration appeared during preparation"))
		}
		if err = atomicWrite(filepath.Join(o.dir, ".env"), initial, 0600); err != nil {
			return fail(err)
		}
	}
	if err = e.installLauncher(state, binary, o.verifier, o.dir, o.development); err != nil {
		return fail(err)
	}
	// Re-evaluate operator configuration after download and before touching the panel.
	rechecked, recheckErr := d.config(ctx, filepath.Join(releaseDir, "docker-compose.yml"), env, o.overrides)
	if recheckErr != nil {
		return fail(recheckErr)
	}
	again, recheckErr := configSnapshot(rechecked, imageRef)
	if recheckErr != nil || string(again) != string(configBytes) {
		return fail(errors.New("configuration changed after preview; retry"))
	}
	if err = d.otherWriters(ctx, self, dataDir); err != nil {
		return fail(err)
	}
	if active != nil {
		if err = checkBackupSpace(dataDir, state); err != nil {
			return fail(err)
		}
	}
	// A signal while the panel still runs ends the operation here instead of stopping the
	// panel only to start it again. Commands that got the signal already failed above.
	if err = ctx.Err(); err != nil {
		return fail(err)
	}
	if err = save("stopping"); err != nil {
		return err
	}
	if active != nil {
		if err = d.compose(ctx, active.Config, "stop", "--timeout", "30", "dockge"); err != nil {
			return e.recoverFailure(o, state, op, d, err)
		}
		if err = checkBackupSpace(dataDir, state); err != nil {
			return e.recoverFailure(o, state, op, d, err)
		}
		if err = save("backing-up"); err != nil {
			return e.recoverFailure(o, state, op, d, err)
		}
		op.Backup = filepath.Join(opDir, "data-backup")
		if err = copyTreeContext(ctx, dataDir, op.Backup); err != nil {
			return e.recoverFailure(o, state, op, d, err)
		}
		if err = d.checkSnapshot(ctx, active.ImageID, op.Backup); err != nil {
			return e.recoverFailure(o, state, op, d, err)
		}
		if err = recordSnapshot(op.Backup); err != nil {
			return e.recoverFailure(o, state, op, d, err)
		}
		op.BackupVerified = true
	}
	if err = save("starting-target"); err != nil {
		return e.recoverFailure(o, state, op, d, err)
	}
	if err = d.up(ctx, targetConfig); err != nil {
		return e.recoverFailure(o, state, op, d, err)
	}
	if err = save("checking-target"); err != nil {
		return e.recoverFailure(o, state, op, d, err)
	}
	if err = d.verifyRuntime(ctx, targetImage.ID, release.Version, false); err != nil {
		return e.recoverFailure(o, state, op, d, err)
	}
	if active != nil {
		if err = writeJSON(filepath.Join(state, "previous.json"), op); err != nil {
			return err
		}
	}
	if err = writeJSON(filepath.Join(state, "active.json"), op.Target); err != nil {
		return err
	}
	if err = save("success"); err != nil {
		return err
	}
	e.message("Update succeeded: the selected image remained healthy. Use .dockge2/update for future updates or --rollback.")
	return nil
}
