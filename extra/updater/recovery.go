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

func (e *engine) checkVersions(ctx context.Context, d docker, r Release) error {
	for _, item := range []struct {
		args    []string
		minimum string
	}{{[]string{"compose", "version", "--short"}, r.MinCompose}, {[]string{"version", "--format", "{{.Server.Version}}"}, r.MinEngine}} {
		output, err := d.command(ctx, item.args...)
		if err != nil {
			return err
		}
		value := strings.TrimPrefix(strings.TrimSpace(string(output)), "v")
		// Vendor suffixes do not change the underlying Engine/Compose feature level.
		value = strings.Split(strings.Split(value, "+")[0], "-")[0]
		if !versionPattern.MatchString(value) || compareVersion(value, item.minimum) < 0 {
			return fmt.Errorf("Docker prerequisite is older than %s", item.minimum)
		}
	}
	return nil
}

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
	if !op.BackupVerified && op.Backup != "" && within(filepath.Join(state, "operations", op.ID), op.Backup) {
		if err := os.RemoveAll(op.Backup); err != nil {
			e.message("Could not remove the incomplete snapshot; inspect disk space before recovery.")
		}
	}
	started := mayHaveStarted(op.Phase)
	if started {
		if err := d.compose(ctx, op.Target.Config, "stop", "--timeout", "30", "dockge"); err != nil {
			op.Phase = "recovery-required"
			_ = writeJSON(filepath.Join(state, "operation.json"), op)
			return fmt.Errorf("update failed; could not stop the target: %w", err)
		}
	}
	if op.Previous == nil || started && op.Previous.Schema != op.Target.Schema {
		op.Phase = "recovery-required"
		_ = writeJSON(filepath.Join(state, "operation.json"), op)
		return fmt.Errorf("update failed: %w; target stopped; inspect the journal and use --rollback --restore-data if the recorded snapshot is required", cause)
	}
	if err := d.up(ctx, op.Previous.Config); err != nil {
		op.Phase = "recovery-required"
		_ = writeJSON(filepath.Join(state, "operation.json"), op)
		return fmt.Errorf("update failed (%v); recovery failed: %w", cause, err)
	}
	if err := d.verifyRuntime(ctx, op.Previous.ImageID, op.Previous.Version, op.Previous.Mode == "legacy"); err != nil {
		op.Phase = "recovery-required"
		_ = writeJSON(filepath.Join(state, "operation.json"), op)
		return err
	}
	op.Phase = "recovered"
	if err := writeJSON(filepath.Join(state, "operation.json"), op); err != nil {
		return err
	}
	return fmt.Errorf("update failed and previous deployment was recovered: %w", cause)
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
		daemon, err := d.localDaemon(ctx)
		if err != nil {
			return err
		}
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
		e.message("The interrupted operation had not stopped the panel; marking it failed before cutover.")
		if o.dryRun {
			return nil
		}
		op.Phase = "failed-before-cutover"
		return writeJSON(filepath.Join(state, "operation.json"), op)
	}
	if err = validateOperation(state, op); err != nil {
		return err
	}
	if o.project != "" && o.project != op.Target.Project {
		return errors.New("rollback project mismatch")
	}
	d := docker{run: e.run, dir: o.dir, project: op.Target.Project}
	daemon, err := d.localDaemon(ctx)
	if err != nil {
		return err
	}
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
		return errors.New("schema changed: rollback requires --restore-data; this discards panel writes after the snapshot, preserves failed data, and does not restore stack volumes")
	}
	if _, err = d.image(ctx, op.Previous.ImageID); err != nil {
		return fmt.Errorf("previous local image unavailable; no mutable tag will replace it: %w", err)
	}
	if o.restoreData {
		if !op.BackupVerified || !within(state, op.Backup) {
			return errors.New("no verified data snapshot")
		}
		if err = verifySnapshot(op.Backup); err != nil {
			return err
		}
		if err = d.checkSnapshot(ctx, op.Previous.ImageID, op.Backup); err != nil {
			return err
		}
	}
	e.message("Rollback to " + op.Previous.Version + " (" + op.Previous.ImageID + ").")
	if o.restoreData {
		e.message("Panel data will be restored; newer writes will remain in the preserved failed-data directory.")
	}
	if o.dryRun {
		return nil
	}
	if err = approved(o.yes); err != nil {
		return err
	}
	op.RestoreData = o.restoreData
	op.Phase = "rolling-back"
	if err = writeJSON(filepath.Join(state, "operation.json"), op); err != nil {
		return err
	}
	if err = d.compose(ctx, op.Target.Config, "stop", "--timeout", "30", "dockge"); err != nil {
		return err
	}
	if o.restoreData {
		// Keep both directories on the data filesystem. The marker makes a crash
		// between the two renames recoverable without overwriting newer data.
		data := op.Previous.DataDir
		staged := data + ".dockge-restore-" + op.ID
		failed := data + ".dockge-failed-" + op.ID
		if !exists(failed) {
			if exists(staged) {
				if err = os.RemoveAll(staged); err != nil {
					return err
				}
			}
			if err = copyTreeContext(ctx, op.Backup, staged); err != nil {
				return err
			}
		}
		if !exists(failed) {
			if err = os.Rename(data, failed); err != nil {
				return err
			}
			if err = syncDir(filepath.Dir(data)); err != nil {
				return err
			}
		}
		if !exists(data) {
			if err = os.Rename(staged, data); err != nil {
				return err
			}
			if err = syncDir(filepath.Dir(data)); err != nil {
				return err
			}
		}
		e.message("Preserved post-update data: " + failed)
	}
	if err = d.up(ctx, op.Previous.Config); err != nil {
		return err
	}
	if err = d.verifyRuntime(ctx, op.Previous.ImageID, op.Previous.Version, op.Previous.Mode == "legacy"); err != nil {
		return err
	}
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
	if err = writeJSON(filepath.Join(state, "operation.json"), op); err != nil {
		return err
	}
	// Retain the recovery executable; it can install the next verified release.
	e.message("Previous deployment restored and checked.")
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
	if op.Previous != nil && !op.BackupVerified {
		return errors.New("backup did not complete; use --rollback to recover before retrying")
	}
	if !exists(filepath.Join(o.dir, ".env")) {
		return errors.New("initial configuration was not written; mark preparation cancelled with --rollback, then repeat installation")
	}
	d := docker{run: e.run, dir: o.dir, project: op.Target.Project}
	daemon, err := d.localDaemon(ctx)
	if err != nil {
		return err
	}
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
	e.message("Retry recorded target " + op.Target.Version + " without restoring data.")
	if o.dryRun {
		return nil
	}
	if err = approved(o.yes); err != nil {
		return err
	}
	if err = e.installLauncher(state, filepath.Join(op.Target.ReleaseDir, "dockge2-update-linux-"+runtime.GOARCH), o.verifier, o.dir, op.Target.Mode == "development"); err != nil {
		return err
	}
	op.Phase = "starting-target"
	if err = writeJSON(filepath.Join(state, "operation.json"), op); err != nil {
		return err
	}
	if err = d.up(ctx, op.Target.Config); err != nil {
		return e.recoverFailure(o, state, op, d, err)
	}
	if err = d.verifyRuntime(ctx, op.Target.ImageID, op.Target.Version, false); err != nil {
		return e.recoverFailure(o, state, op, d, err)
	}
	if op.Previous != nil {
		if err = writeJSON(filepath.Join(state, "previous.json"), op); err != nil {
			return err
		}
	}
	if err = writeJSON(filepath.Join(state, "active.json"), op.Target); err != nil {
		return err
	}
	op.Phase = "success"
	return writeJSON(filepath.Join(state, "operation.json"), op)
}
