package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

func (e *engine) validatePrevious(ctx context.Context, d docker, c *containerInfo, current composeConfig, active *installed, r Release, base string) (*installed, error) {
	if c == nil || !digestPattern.MatchString(c.Image) {
		return nil, errors.New("missing previous image identity")
	}
	mounts := current.mountSources()
	for _, m := range c.Mounts {
		if mounts[m.Destination] != m.Type+":"+m.Source {
			return nil, errors.New("running mounts differ from selected configuration; resolve this explicitly")
		}
		delete(mounts, m.Destination)
	}
	if len(mounts) != 0 {
		return nil, errors.New("configured mounts are absent from the running panel")
	}
	data, err := current.dataDir()
	if err != nil {
		return nil, err
	}
	if active != nil {
		if active.ImageID != c.Image || active.Project != d.project || active.DataDir != data || !versionPattern.MatchString(active.Version) || !hashPattern.MatchString(active.Schema) {
			return nil, errors.New("running deployment disagrees with updater state")
		}
		descriptor, err := readRegular(filepath.Join(active.ReleaseDir, "release.json"), maxMetadata)
		if err != nil {
			return nil, err
		}
		var old Release
		if err = decodeStrict(descriptor, &old); err != nil {
			return nil, err
		}
		vendor, err := readRegular(base, maxMetadata)
		if err != nil {
			return nil, err
		}
		if old.Version != active.Version || old.Schema != active.Schema || fileHash(vendor) != old.Assets["docker-compose.yml"].SHA256 {
			return nil, errors.New("managed Compose file was edited; put customizations in an explicit override")
		}
		return active, nil
	}
	// A legacy snapshot cannot be reconstructed from changed environment settings.
	actualEnv := map[string]string{}
	for _, item := range c.Config.Env {
		parts := strings.SplitN(item, "=", 2)
		if len(parts) == 2 {
			actualEnv[parts[0]] = parts[1]
		}
	}
	expectedEnv, _ := current.Services["dockge"]["environment"].(map[string]any)
	for key, value := range expectedEnv {
		if value != nil && actualEnv[key] != fmt.Sprint(value) {
			return nil, errors.New("legacy environment differs from the running panel; restore the original configuration before import")
		}
	}
	if command, ok := current.Services["dockge"]["command"].([]any); ok {
		expected := []string{}
		for _, v := range command {
			expected = append(expected, fmt.Sprint(v))
		}
		if stringMustJSON(expected) != stringMustJSON(c.Config.Cmd) {
			return nil, errors.New("legacy command differs from the running panel")
		}
	}
	ports := map[string][]string{}
	configuredPorts, _ := current.Services["dockge"]["ports"].([]any)
	for _, raw := range configuredPorts {
		port, _ := raw.(map[string]any)
		protocol, _ := port["protocol"].(string)
		if protocol == "" {
			protocol = "tcp"
		}
		key := fmt.Sprint(port["target"]) + "/" + protocol
		host, _ := port["host_ip"].(string)
		if host == "" {
			host = "0.0.0.0"
		}
		ports[key] = append(ports[key], host+":"+fmt.Sprint(port["published"]))
	}
	actualPorts := map[string][]string{}
	for key, bindings := range c.HostConfig.PortBindings {
		for _, binding := range bindings {
			host := binding.HostIP
			if host == "" {
				host = "0.0.0.0"
			}
			actualPorts[key] = append(actualPorts[key], host+":"+binding.HostPort)
		}
	}
	if stringMustJSON(ports) != stringMustJSON(actualPorts) {
		return nil, errors.New("legacy published ports differ from the running panel")
	}
	// Legacy import is deliberately limited to a tested version and exact vendor file.
	// The running package, not a mutable tag or the checkout, establishes that version.
	if !c.State.Running {
		return nil, errors.New("legacy import needs the existing panel running to establish its version")
	}
	output, err := d.command(ctx, "exec", c.ID, "node", "-p", "require('/app/package.json').version")
	if err != nil {
		return nil, err
	}
	version := strings.TrimSpace(string(output))
	legacy, ok := r.Legacy[version]
	if !ok || !versionPattern.MatchString(version) {
		return nil, errors.New("this legacy version has no tested import contract")
	}
	// Verify the schema-bearing files of a local build too; a package version alone is insufficient.
	schemaOutput, schemaErr := d.command(ctx, "exec", c.ID, "node", "-e", `const fs=require('fs'),crypto=require('crypto');const hash=b=>crypto.createHash('sha256').update(b).digest('hex');const files=fs.readdirSync('/app/backend/migrations').filter(n=>n.endsWith('.ts')).map(n=>'backend/migrations/'+n).concat(['backend/auth.ts','backend/auth-runtime.ts','backend/auth-access.ts','package-lock.json']).sort();console.log(hash(files.map(n=>n+':'+(n==='package-lock.json'?hash(Object.entries(JSON.parse(fs.readFileSync('/app/'+n)).packages).filter(([k])=>k!=='').sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,p])=>k+':'+(p.version||'')+':'+(p.integrity||'')+':'+(p.resolved||'')+'\n').join('')):hash(fs.readFileSync('/app/'+n)))+'\n').join('')));`)
	if schemaErr != nil {
		return nil, schemaErr
	}
	if strings.TrimSpace(string(schemaOutput)) != legacy.Schema {
		return nil, errors.New("legacy build schema differs from the tested import contract")
	}
	vendor, err := readRegular(base, maxMetadata)
	if err != nil {
		return nil, err
	}
	if fileHash(vendor) != legacy.ComposeHash {
		return nil, errors.New("local Compose edits need an explicit override and the matching released base file; nothing was changed")
	}
	// Keep the descriptor readable by the installed 0.0.10 updater. The new,
	// signed binary pins the additional identity required for unmanaged import.
	if version == "0.0.10" {
		const publishedDigest = "sha256:edf9bd51346f47c9c89d65b6bbe9c1da3d2d028dbcb45109dfc895164871d71b"
		const publishedCommit = "f6bdbfb2f907fd78ba3737edd836f5b5c1e2d822"
		image, inspectErr := d.image(ctx, c.Image)
		if inspectErr != nil {
			return nil, inspectErr
		}
		found := false
		for _, ref := range image.RepoDigests {
			if ref == r.Image+"@"+publishedDigest {
				found = true
			}
		}
		if image.ID != c.Image || !found || image.Config.Labels["org.opencontainers.image.version"] != version ||
			image.Config.Labels["org.opencontainers.image.revision"] != publishedCommit {
			return nil, errors.New("running legacy image differs from the signed release identity")
		}
	}
	return &installed{Version: version, Schema: legacy.Schema, ImageID: c.Image, Project: d.project, DataDir: data, Mode: "legacy"}, nil
}

func mayHaveStarted(phase string) bool {
	switch phase {
	case "prepared", "downloaded", "stopping", "backing-up", "failed-before-cutover":
		return false
	default:
		return true
	}
}
func (e *engine) recoverFailure(o options, state string, op operation, d docker, cause error) error {
	// Recovery gets its own deadline even if SIGTERM cancelled the update context.
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Minute)
	defer cancel()
	op.Error = redact(cause.Error())
	e.fail(cause)
	e.reported = true
	e.section("Recovery")
	required := func(err, result error) error {
		e.fail(err)
		op.Phase = "recovery-required"
		_ = e.writeJournal(state, op)
		return result
	}
	if !op.BackupVerified && op.Backup != "" && within(filepath.Join(state, "operations", op.ID), op.Backup) {
		if err := os.RemoveAll(op.Backup); err != nil {
			e.warn("could not remove the incomplete data copy; check the free disk space")
		}
	}
	started := mayHaveStarted(op.Phase)
	if started {
		e.begin("stopping " + op.Target.Version)
		if err := d.compose(ctx, op.Target.Config, "stop", "--timeout", "30", "dockge"); err != nil {
			return required(err, fmt.Errorf("update failed; could not stop the target: %w", err))
		}
		e.ok(op.Target.Version + " stopped")
	}
	if op.Previous != nil && started && op.Previous.Schema != op.Target.Schema && o.restoreOnFailedStart {
		return e.restoreAfterFailedStart(state, op, d, cause)
	}
	if op.Previous == nil || started && op.Previous.Schema != op.Target.Schema {
		op.Phase = "recovery-required"
		_ = e.writeJournal(state, op)
		if op.Previous == nil {
			e.warn("the new installation is stopped")
			details(e.failures(), "Fix the cause above, then start it again:\n"+launcher(o.dir)+" --resume")
		} else {
			e.warn(op.Previous.Version + " was not started: the database schema changed, so it needs the data copy")
			details(e.failures(), "To go back to it with the data copy:\n"+launcher(o.dir)+" --rollback --restore-data")
		}
		return fmt.Errorf("update failed: %w; target stopped; inspect the journal and use --rollback --restore-data if the recorded snapshot is required", cause)
	}
	e.begin("starting " + op.Previous.Version)
	if err := d.up(ctx, op.Previous.Config); err != nil {
		return required(err, fmt.Errorf("update failed (%w); recovery failed: %w", cause, err))
	}
	e.ok(op.Previous.Version + " started")
	e.begin("checking that " + op.Previous.Version + " stays healthy")
	if err := d.verifyRuntime(ctx, op.Previous.ImageID, op.Previous.Version, op.Previous.Mode == "legacy"); err != nil {
		return required(err, err)
	}
	e.ok(op.Previous.Version + " is healthy")
	op.Phase = "recovered"
	if err := e.writeJournal(state, op); err != nil {
		return err
	}
	return fmt.Errorf("update failed and previous deployment was recovered: %w", cause)
}

// restoreAfterFailedStart is --restore-on-failed-start: the target may have migrated the data
// and is stopped, so the previous deployment comes back only on the verified snapshot. It
// is the restore of --rollback --restore-data, with its own deadline after the stop.
func (e *engine) restoreAfterFailedStart(state string, op operation, d docker, cause error) error {
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Minute)
	defer cancel()
	required := func(err error) error {
		e.fail(err)
		details(e.failures(), "To finish the rollback with the data copy:\n"+launcher(filepath.Dir(state))+" --rollback --restore-data")
		op.Phase = "recovery-required"
		_ = e.writeJournal(state, op)
		return fmt.Errorf("update failed: %w; target stopped; automatic data restore did not complete: %w; inspect the journal and use --rollback --restore-data", cause, err)
	}
	e.begin("checking the data copy")
	binary, err := e.checkRestore(ctx, d, state, op)
	if err != nil {
		return required(err)
	}
	op.RestoreData = true
	op.Phase = "rolling-back"
	if err = e.writeJournal(state, op); err != nil {
		return required(err)
	}
	e.begin("restoring the data copy")
	if err = d.restoreSnapshot(ctx, op.Previous.ImageID, binary, op.Previous.DataDir, op.Backup, op.ID); err != nil {
		// The journal keeps rolling-back while a restore container may still write.
		if errors.Is(err, errRestoreRunning) {
			e.fail(err)
			return fmt.Errorf("update failed: %w; target stopped; %w", cause, err)
		}
		return required(err)
	}
	e.ok("data restored; what " + op.Target.Version + " wrote is kept in " + failedDataDir(op.Previous.DataDir, op.ID))
	e.begin("starting " + op.Previous.Version)
	if err = d.up(ctx, op.Previous.Config); err != nil {
		return required(err)
	}
	e.ok(op.Previous.Version + " started")
	e.begin("checking that " + op.Previous.Version + " stays healthy")
	if err = d.verifyRuntime(ctx, op.Previous.ImageID, op.Previous.Version, op.Previous.Mode == "legacy"); err != nil {
		return required(err)
	}
	e.ok(op.Previous.Version + " is healthy")
	op.Phase = "recovered"
	if err = e.writeJournal(state, op); err != nil {
		return err
	}
	e.report.restoredData = true
	return fmt.Errorf("update failed; data snapshot and previous deployment were restored, post-update data kept in %s: %w", failedDataDir(op.Previous.DataDir, op.ID), cause)
}

func loadOperation(path string) (operation, error) {
	var op operation
	b, err := readRegular(path, maxMetadata)
	if err == nil {
		err = decodeStrict(b, &op)
	}
	return op, err
}
func validateOperation(state string, op operation) error {
	if op.Previous == nil {
		return errors.New("there is no recorded previous deployment")
	}
	for _, v := range []installed{*op.Previous, op.Target} {
		if !within(state, v.Config) || !digestPattern.MatchString(v.ImageID) || !versionPattern.MatchString(v.Version) || !hashPattern.MatchString(v.Schema) || !filepath.IsAbs(v.DataDir) || v.DataDir == "/" {
			return errors.New("invalid recovery record")
		}
	}
	if op.Target.Project != op.Previous.Project || op.Target.DataDir != op.Previous.DataDir {
		return errors.New("recovery identity mismatch")
	}
	return nil
}
func (e *engine) rollback(ctx context.Context, o options, state string) error {
	journalBefore, err := readRegular(filepath.Join(state, "operation.json"), maxMetadata)
	if err != nil {
		return err
	}
	op, err := loadOperation(filepath.Join(state, "operation.json"))
	if err != nil {
		return err
	}
	switch op.Phase {
	case "success", "recovered", "failed-before-cutover":
		op, err = loadOperation(filepath.Join(state, "previous.json"))
		if err != nil {
			return err
		}
	}
	if op.Phase == "prepared" || op.Phase == "downloaded" {
		d := docker{run: e.run, dir: o.dir, project: op.Target.Project}
		daemon, err := e.dockerDaemon(ctx, d)
		if err != nil {
			return err
		}
		e.section("Rollback")
		e.begin("checking the interrupted operation")
		lock, err := lockProject(daemon, d.project)
		if err != nil {
			return err
		}
		defer lock.Close()
		dataLock, lockErr := lockProject(daemon, "data:"+op.Target.DataDir)
		if lockErr != nil {
			return lockErr
		}
		defer dataLock.Close()
		journalNow, readErr := readRegular(filepath.Join(state, "operation.json"), maxMetadata)
		if readErr != nil {
			return readErr
		}
		if string(journalBefore) != string(journalNow) {
			return errors.New("operation changed during recovery preparation; retry")
		}
		actual, err := d.container(ctx)
		if err != nil {
			return err
		}
		if op.Previous == nil && actual != nil || op.Previous != nil && (actual == nil || actual.Image != op.Previous.ImageID) {
			return errors.New("deployment changed during an interrupted preparation")
		}
		e.ok("the interrupted operation " + op.ID + " had not stopped the panel")
		if o.dryRun {
			e.closing("Preview only: the journal was not changed.",
				"To mark the operation failed before cutover, run the same command with --yes instead of --dry-run.")
			return nil
		}
		op.Phase = "failed-before-cutover"
		if err = e.writeJournal(state, op); err != nil {
			return err
		}
		e.ok("operation marked failed before cutover; the next update can start")
		return nil
	}
	if err = validateOperation(state, op); err != nil {
		return err
	}
	if o.project != "" && o.project != op.Target.Project {
		return errors.New("rollback project mismatch")
	}
	d := docker{run: e.run, dir: o.dir, project: op.Target.Project}
	daemon, err := e.dockerDaemon(ctx, d)
	if err != nil {
		return err
	}
	e.section("Rollback")
	e.begin("checking the recorded operation")
	lock, err := lockProject(daemon, d.project)
	if err != nil {
		return err
	}
	defer lock.Close()
	dataLock, lockErr := lockProject(daemon, "data:"+op.Target.DataDir)
	if lockErr != nil {
		return lockErr
	}
	defer dataLock.Close()
	journalNow, readErr := readRegular(filepath.Join(state, "operation.json"), maxMetadata)
	if readErr != nil {
		return readErr
	}
	if string(journalBefore) != string(journalNow) {
		return errors.New("operation changed during recovery preparation; retry")
	}
	container, err := d.container(ctx)
	if err != nil {
		return err
	}
	self := ""
	if container != nil {
		self = container.ID
	}
	if err = d.otherWriters(ctx, self, op.Target.DataDir); err != nil {
		return err
	}
	if container != nil && container.Image != op.Target.ImageID && container.Image != op.Previous.ImageID {
		return errors.New("current image is outside the recorded operation")
	}
	mustRestore := op.RestoreData || mayHaveStarted(op.Phase) && op.Target.Schema != op.Previous.Schema
	if mustRestore && !o.restoreData {
		return withHint(errors.New("schema changed: rollback requires --restore-data; this discards panel writes after the snapshot, preserves failed data, and does not restore stack volumes"),
			"Preview it: "+launcher(o.dir)+" --rollback --restore-data --dry-run")
	}
	if _, err = d.image(ctx, op.Previous.ImageID); err != nil {
		return fmt.Errorf("previous local image unavailable; no mutable tag will replace it: %w", err)
	}
	binary := ""
	if o.restoreData {
		if binary, err = e.checkRestore(ctx, d, state, op); err != nil {
			return err
		}
	}
	e.settle()
	e.field("Action", "roll back "+op.Target.Version+" to "+op.Previous.Version+", image "+shortID(op.Previous.ImageID))
	if o.restoreData {
		e.field("Data", "restored from the copy made before the update")
		e.note("What " + op.Target.Version + " wrote is kept in " + failedDataDir(op.Previous.DataDir, op.ID) + ".")
		e.note("Stack volumes are not restored.")
	}
	if o.dryRun {
		e.closing("Preview only: nothing was stopped, restored or started.",
			"To apply it, run the same command with --yes instead of --dry-run.")
		return nil
	}
	if err = approved(o.yes, "Roll back to "+op.Previous.Version+"? The panel is unavailable while it restarts."); err != nil {
		return err
	}
	e.section("Rolling back to " + op.Previous.Version)
	op.RestoreData = o.restoreData
	op.Phase = "rolling-back"
	if err = e.writeJournal(state, op); err != nil {
		return err
	}
	e.begin("stopping " + op.Target.Version)
	if err = d.compose(ctx, op.Target.Config, "stop", "--timeout", "30", "dockge"); err != nil {
		return err
	}
	e.ok(op.Target.Version + " stopped")
	if o.restoreData {
		e.begin("restoring the data copy")
		if err = d.restoreSnapshot(ctx, op.Previous.ImageID, binary, op.Previous.DataDir, op.Backup, op.ID); err != nil {
			return err
		}
		e.ok("data restored; what " + op.Target.Version + " wrote is kept in " + failedDataDir(op.Previous.DataDir, op.ID))
	}
	e.begin("starting " + op.Previous.Version)
	if err = d.up(ctx, op.Previous.Config); err != nil {
		return err
	}
	e.ok(op.Previous.Version + " started")
	e.begin("checking that " + op.Previous.Version + " stays healthy")
	if err = d.verifyRuntime(ctx, op.Previous.ImageID, op.Previous.Version, op.Previous.Mode == "legacy"); err != nil {
		return err
	}
	e.ok(op.Previous.Version + " is healthy")
	if op.Previous.Mode == "legacy" {
		if err = os.Remove(filepath.Join(state, "active.json")); err != nil && !os.IsNotExist(err) {
			return err
		}
	} else {
		if err = writeJSON(filepath.Join(state, "active.json"), op.Previous); err != nil {
			return err
		}
	}
	op.Phase = "recovered"
	if err = e.writeJournal(state, op); err != nil {
		return err
	}
	// Retain the recovery executable; it can install the next verified release.
	e.section("Done")
	e.note("Dockge2 " + op.Previous.Version + " is running again.")
	e.field("Updates", launcher(o.dir)+" --dry-run")
	return nil
}

func shellQuote(s string) string { return "'" + strings.ReplaceAll(s, "'", "'\"'\"'") + "'" }
func (e *engine) installLauncher(state, binary, verifier, dir string, development bool) error {
	bin := filepath.Join(state, "bin")
	if err := privateDir(bin); err != nil {
		return err
	}
	if !filepath.IsAbs(verifier) {
		p, err := exec.LookPath(verifier)
		if err != nil {
			return err
		}
		verifier = p
	}
	if err := atomicCopy(verifier, filepath.Join(bin, "cosign"), 0700, 200<<20); err != nil {
		return err
	}
	// The launcher is replaced atomically, never the currently executing binary.
	script := "#!/bin/sh\nexec " + shellQuote(binary) + " --dir " + shellQuote(dir) + " --verifier " + shellQuote(filepath.Join(bin, "cosign")) + " --update \"$@\"\n"
	return atomicWrite(filepath.Join(state, "update"), []byte(script), 0700)
}

func (e *engine) development(ctx context.Context, o options, stage string) (Release, error) {
	var r Release
	if strings.HasPrefix(o.ref, "-") || strings.ContainsAny(o.ref, "\r\n") {
		return r, errors.New("invalid development ref")
	}
	source := filepath.Join(filepath.Dir(stage), "source")
	e.devSource = source
	if _, err := e.run.run(ctx, "git", "init", source); err != nil {
		return r, err
	}
	if _, err := e.run.run(ctx, "git", "-C", source, "fetch", "--depth=1", "https://github.com/"+repository+".git", o.ref); err != nil {
		return r, err
	}
	if _, err := e.run.run(ctx, "git", "-C", source, "checkout", "--detach", "FETCH_HEAD"); err != nil {
		return r, err
	}
	commit, err := e.run.run(ctx, "git", "-C", source, "rev-parse", "HEAD")
	if err != nil {
		return r, err
	}
	pkg, err := readRegular(filepath.Join(source, "package.json"), maxMetadata)
	if err != nil {
		return r, err
	}
	var p struct {
		Version string `json:"version"`
	}
	if err = json.Unmarshal(pkg, &p); err != nil {
		return r, err
	}
	if !versionPattern.MatchString(p.Version) {
		return r, errors.New("invalid development package version")
	}
	schema, err := schemaHash(source)
	if err != nil {
		return r, err
	}
	r = Release{Format: 1, Version: p.Version, Commit: strings.TrimSpace(string(commit)), Channel: "development", MinCompose: "2.20.0", MinEngine: "24.0.0", MinVersion: "0.0.8", Schema: schema, Assets: map[string]Asset{}}
	if err = privateDir(stage); err != nil {
		return r, err
	}
	compose, err := readRegular(filepath.Join(source, "docker-compose.yml"), maxMetadata)
	if err != nil {
		return r, err
	}
	r.Assets["docker-compose.yml"] = Asset{SHA256: fileHash(compose), Size: int64(len(compose))}
	if err = atomicWrite(filepath.Join(stage, "docker-compose.yml"), compose, 0600); err != nil {
		return r, err
	}
	self, err := os.Executable()
	if err != nil {
		return r, err
	}
	b, err := readRegular(self, 64<<20)
	if err != nil {
		return r, err
	}
	if err = atomicWrite(filepath.Join(stage, "dockge2-update-linux-"+runtime.GOARCH), b, 0700); err != nil {
		return r, err
	}
	err = writeJSON(filepath.Join(stage, "release.json"), r)
	return r, err
}

// resumeOperation retries an already authenticated, durable target without changing its source.
func (e *engine) resumeOperation(ctx context.Context, o options, state string) error {
	journalBefore, err := readRegular(filepath.Join(state, "operation.json"), maxMetadata)
	if err != nil {
		return err
	}
	op, err := loadOperation(filepath.Join(state, "operation.json"))
	if err != nil {
		return err
	}
	switch op.Phase {
	case "downloaded", "starting-target", "checking-target", "recovery-required":
	default:
		return errors.New("this phase cannot resume the target; inspect --status and recover with --rollback")
	}
	if !within(state, op.Target.Config) || !digestPattern.MatchString(op.Target.ImageID) || !versionPattern.MatchString(op.Target.Version) {
		return errors.New("invalid target recovery record")
	}
	// Once the snapshot of this operation was restored, or its restore began, the target
	// would migrate the restored data again, and a later rollback would take that data for
	// the restored snapshot: the markers belong to the operation id, not to the attempt.
	if op.Previous != nil && (op.RestoreData || exists(failedDataDir(op.Previous.DataDir, op.ID))) {
		return errors.New("the data snapshot of this operation was restored or its restore began; finish with --rollback --restore-data, then start a new update")
	}
	if op.Previous != nil && !op.BackupVerified {
		return errors.New("backup did not complete; use --rollback to recover before retrying")
	}
	if !exists(filepath.Join(o.dir, ".env")) {
		return errors.New("initial configuration was not written; mark preparation cancelled with --rollback, then repeat installation")
	}
	d := docker{run: e.run, dir: o.dir, project: op.Target.Project}
	daemon, err := e.dockerDaemon(ctx, d)
	if err != nil {
		return err
	}
	e.section("Resume")
	e.begin("checking the recorded operation")
	lock, err := lockProject(daemon, d.project)
	if err != nil {
		return err
	}
	defer lock.Close()
	dataLock, lockErr := lockProject(daemon, "data:"+op.Target.DataDir)
	if lockErr != nil {
		return lockErr
	}
	defer dataLock.Close()
	journalNow, readErr := readRegular(filepath.Join(state, "operation.json"), maxMetadata)
	if readErr != nil {
		return readErr
	}
	if string(journalBefore) != string(journalNow) {
		return errors.New("operation changed during recovery preparation; retry")
	}
	actual, err := d.container(ctx)
	if err != nil {
		return err
	}
	if actual != nil && actual.Image != op.Target.ImageID && (op.Previous == nil || actual.Image != op.Previous.ImageID) {
		return errors.New("unexpected deployment identity")
	}
	self := ""
	if actual != nil {
		self = actual.ID
	}
	if err = d.otherWriters(ctx, self, op.Target.DataDir); err != nil {
		return err
	}
	if _, err = d.image(ctx, op.Target.ImageID); err != nil {
		return err
	}
	if op.Previous != nil {
		if err = verifySnapshot(op.Backup); err != nil {
			return err
		}
	}
	e.settle()
	e.field("Action", "start the recorded "+op.Target.Version+" again, image "+shortID(op.Target.ImageID))
	e.note("The data is not restored.")
	if o.dryRun {
		e.closing("Preview only: nothing was started.",
			"To apply it, run the same command with --yes instead of --dry-run.")
		return nil
	}
	if err = approved(o.yes, "Start "+op.Target.Version+" again?"); err != nil {
		return err
	}
	e.section("Starting " + op.Target.Version + " again")
	if err = e.installLauncher(state, filepath.Join(op.Target.ReleaseDir, "dockge2-update-linux-"+runtime.GOARCH), o.verifier, o.dir, op.Target.Mode == "development"); err != nil {
		return err
	}
	op.Phase = "starting-target"
	if err = e.writeJournal(state, op); err != nil {
		return err
	}
	e.begin("starting " + op.Target.Version)
	if err = d.up(ctx, op.Target.Config); err != nil {
		return e.recoverFailure(o, state, op, d, err)
	}
	e.ok(op.Target.Version + " started")
	e.begin("checking that " + op.Target.Version + " stays healthy")
	if err = d.verifyRuntime(ctx, op.Target.ImageID, op.Target.Version, false); err != nil {
		return e.recoverFailure(o, state, op, d, err)
	}
	e.ok(op.Target.Version + " is healthy")
	if op.Previous != nil {
		if err = writeJSON(filepath.Join(state, "previous.json"), op); err != nil {
			return err
		}
	}
	if err = writeJSON(filepath.Join(state, "active.json"), op.Target); err != nil {
		return err
	}
	op.Phase = "success"
	if err = e.writeJournal(state, op); err != nil {
		return err
	}
	e.section("Done")
	e.note("Dockge2 " + op.Target.Version + " is running.")
	return nil
}
