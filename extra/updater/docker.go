package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"syscall"
	"time"
)

type runner interface {
	run(context.Context, string, ...string) ([]byte, error)
}
type commandRunner struct{}
type boundedBuffer struct{ bytes.Buffer }

func (b *boundedBuffer) Write(p []byte) (int, error) {
	n := len(p)
	left := (4 << 20) - b.Len()
	if left > 0 {
		if len(p) > left {
			p = p[:left]
		}
		b.Buffer.Write(p)
	}
	return n, nil
}

var credentials = regexp.MustCompile(`(?i)(https?://)[^\s/@]+:[^\s/@]+@`)
var secretValue = regexp.MustCompile(`(?i)((?:password|token|secret|authorization|cookie)[=:]\s*)\S+`)

func redact(s string) string {
	s = credentials.ReplaceAllString(s, "${1}[REDACTED]@")
	return secretValue.ReplaceAllString(s, "${1}[REDACTED]")
}
func (commandRunner) run(ctx context.Context, command string, args ...string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Minute)
	defer cancel()
	cmd := exec.CommandContext(ctx, command, args...)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error { return syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL) }
	cmd.WaitDelay = 5 * time.Second
	var stdout, stderr boundedBuffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err := cmd.Run()
	if err != nil {
		detail := strings.TrimSpace(redact(stderr.String()))
		if len(detail) > 4000 {
			detail = detail[len(detail)-4000:]
		}
		return nil, fmt.Errorf("%s failed: %w\n%s", filepath.Base(command), err, detail)
	}
	return stdout.Bytes(), nil
}

type composeConfig struct {
	Name     string                    `json:"name"`
	Services map[string]map[string]any `json:"services"`
	Extra    map[string]any            `json:"-"`
}

func parseConfig(data []byte) (composeConfig, error) {
	var c composeConfig
	if err := json.Unmarshal(data, &c); err != nil {
		return c, err
	}
	if err := json.Unmarshal(data, &c.Extra); err != nil {
		return c, err
	}
	if len(c.Services) != 1 || c.Services["dockge"] == nil {
		return c, errors.New("panel configuration must contain only the dockge service")
	}
	if !regexp.MustCompile(`^[a-z0-9][a-z0-9_-]*$`).MatchString(c.Name) {
		return c, errors.New("invalid Compose project identity")
	}
	return c, nil
}
func (c composeConfig) image() string {
	value, _ := c.Services["dockge"]["image"].(string)
	return value
}
func (c composeConfig) env(name string) string {
	e, _ := c.Services["dockge"]["environment"].(map[string]any)
	value, _ := e[name].(string)
	return value
}
func (c composeConfig) dataDir() (string, error) {
	mounts, _ := c.Services["dockge"]["volumes"].([]any)
	for _, v := range mounts {
		m, _ := v.(map[string]any)
		if m["target"] == "/app/data" && m["type"] == "bind" {
			source, _ := m["source"].(string)
			if !filepath.IsAbs(source) || source == "/" {
				break
			}
			return filepath.Clean(source), nil
		}
	}
	return "", errors.New("updates require an explicit host bind mount for /app/data")
}
func (c composeConfig) mountSources() map[string]string {
	out := map[string]string{}
	mounts, _ := c.Services["dockge"]["volumes"].([]any)
	for _, v := range mounts {
		m, _ := v.(map[string]any)
		target, _ := m["target"].(string)
		source, _ := m["source"].(string)
		kind, _ := m["type"].(string)
		out[target] = kind + ":" + source
	}
	return out
}

// escapeInterpolation prevents Compose from expanding dollars in an already resolved snapshot.
func escapeInterpolation(v any) any {
	switch x := v.(type) {
	case string:
		return strings.ReplaceAll(x, "$", "$$")
	case []any:
		for i := range x {
			x[i] = escapeInterpolation(x[i])
		}
	case map[string]any:
		for k, val := range x {
			x[k] = escapeInterpolation(val)
		}
	}
	return v
}
func configSnapshot(c composeConfig, image string) ([]byte, error) {
	service := c.Services["dockge"]
	service["image"] = image
	delete(service, "build")
	service["pull_policy"] = "never"
	c.Extra["services"] = map[string]any{"dockge": service}
	// Do not mutate the source object while escaping (also used for comparisons).
	data, err := json.Marshal(c.Extra)
	if err != nil {
		return nil, err
	}
	var copy any
	if err = json.Unmarshal(data, &copy); err != nil {
		return nil, err
	}
	return json.MarshalIndent(escapeInterpolation(copy), "", "  ")
}

// pinSnapshot retains the already escaped values of a managed snapshot.
func pinSnapshot(data []byte, image string) ([]byte, error) {
	c, err := parseConfig(data)
	if err != nil {
		return nil, err
	}
	c.Services["dockge"]["image"] = image
	c.Extra["services"] = c.Services
	return json.MarshalIndent(c.Extra, "", "  ")
}

type docker struct {
	run          runner
	dir, project string
}

func (d docker) command(ctx context.Context, args ...string) ([]byte, error) {
	return d.run.run(ctx, "docker", args...)
}
func (d docker) config(ctx context.Context, base, env string, overrides []string) (composeConfig, error) {
	args := []string{"compose", "--project-directory", d.dir}
	if d.project != "" {
		args = append(args, "-p", d.project)
	}
	if env != "" {
		args = append(args, "--env-file", env)
	}
	args = append(args, "-f", base)
	for _, file := range overrides {
		args = append(args, "-f", file)
	}
	data, err := d.command(ctx, append(args, "config", "--format", "json")...)
	if err != nil {
		return composeConfig{}, err
	}
	return parseConfig(data)
}
func (d docker) compose(ctx context.Context, config string, args ...string) error {
	base := []string{"compose", "--project-directory", d.dir, "-p", d.project, "-f", config}
	_, err := d.command(ctx, append(base, args...)...)
	return err
}
func (d docker) up(ctx context.Context, config string) error {
	return d.compose(ctx, config, "up", "-d", "--no-build", "--pull", "never", "--no-deps", "--wait", "--wait-timeout", "180", "dockge")
}

type containerInfo struct {
	ID           string `json:"Id"`
	Image        string `json:"Image"`
	RestartCount int    `json:"RestartCount"`
	Config       struct {
		Labels map[string]string `json:"Labels"`
		Env    []string          `json:"Env"`
		Cmd    []string          `json:"Cmd"`
	} `json:"Config"`
	State struct {
		Running bool `json:"Running"`
		Health  *struct {
			Status string `json:"Status"`
		} `json:"Health"`
	} `json:"State"`
	HostConfig struct {
		PortBindings map[string][]struct {
			HostIP   string `json:"HostIp"`
			HostPort string `json:"HostPort"`
		} `json:"PortBindings"`
	} `json:"HostConfig"`
	Mounts []struct {
		Type        string `json:"Type"`
		Source      string `json:"Source"`
		Destination string `json:"Destination"`
	} `json:"Mounts"`
}
type imageInfo struct {
	Architecture string `json:"Architecture"`
	OS           string `json:"Os"`
	ID           string `json:"Id"`
	Config       struct {
		Labels map[string]string `json:"Labels"`
	} `json:"Config"`
}

func (d docker) image(ctx context.Context, ref string) (imageInfo, error) {
	var result []imageInfo
	data, err := d.command(ctx, "image", "inspect", ref)
	if err != nil {
		return imageInfo{}, err
	}
	if json.Unmarshal(data, &result) != nil || len(result) != 1 || !digestPattern.MatchString(result[0].ID) {
		return imageInfo{}, errors.New("invalid image identity")
	}
	return result[0], nil
}
func (d docker) container(ctx context.Context) (*containerInfo, error) {
	data, err := d.command(ctx, "ps", "-a", "--filter", "label=com.docker.compose.project="+d.project, "--filter", "label=com.docker.compose.service=dockge", "--format", "{{.ID}}")
	if err != nil {
		return nil, err
	}
	ids := strings.Fields(string(data))
	if len(ids) == 0 {
		return nil, nil
	}
	if len(ids) != 1 {
		return nil, errors.New("ambiguous panel containers")
	}
	data, err = d.command(ctx, "inspect", ids[0])
	if err != nil {
		return nil, err
	}
	var result []containerInfo
	if json.Unmarshal(data, &result) != nil || len(result) != 1 {
		return nil, errors.New("invalid container inspection")
	}
	c := result[0]
	workingDir, err := filepath.EvalSymlinks(c.Config.Labels["com.docker.compose.project.working_dir"])
	if err != nil || workingDir != d.dir {
		return nil, errors.New("the Compose project belongs to another installation directory")
	}
	return &c, nil
}
func (d docker) localDaemon(ctx context.Context) (string, error) {
	host := os.Getenv("DOCKER_HOST")
	if host == "" || os.Getenv("DOCKER_CONTEXT") != "" {
		data, err := d.command(ctx, "context", "inspect", "--format", "{{.Endpoints.docker.Host}}")
		if err != nil {
			return "", err
		}
		host = strings.TrimSpace(string(data))
	}
	if !strings.HasPrefix(host, "unix://") {
		return "", errors.New("run the updater on the Docker host; remote endpoints cannot safely snapshot local data")
	}
	data, err := d.command(ctx, "info", "--format", "{{.ID}}")
	if err != nil {
		return "", err
	}
	id := strings.TrimSpace(string(data))
	if id == "" {
		return "", errors.New("Docker daemon identity is unavailable")
	}
	return id, nil
}
func (d docker) verifyRuntime(ctx context.Context, expected, version string, legacy bool) error {
	first, err := d.container(ctx)
	if err != nil {
		return err
	}
	if first == nil || first.Image != expected || !first.State.Running || first.State.Health == nil || first.State.Health.Status != "healthy" {
		return errors.New("target image is not running and healthy")
	}
	output, err := d.command(ctx, "exec", first.ID, "node", "-p", "require('/app/package.json').version")
	if err != nil {
		return err
	}
	if strings.TrimSpace(string(output)) != version {
		return errors.New("running application version differs from selected release")
	}
	if !legacy {
		if _, err = d.command(ctx, "exec", first.ID, "/app/extra/healthcheck"); err != nil {
			return err
		}
	}
	timer := time.NewTimer(10 * time.Second)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
	}
	next, err := d.container(ctx)
	if err != nil {
		return err
	}
	if next == nil || next.ID != first.ID || next.Image != expected || next.RestartCount != first.RestartCount || !next.State.Running || next.State.Health == nil || next.State.Health.Status != "healthy" {
		return errors.New("target did not remain healthy during the stability check")
	}
	return nil
}
func (d docker) checkSnapshot(ctx context.Context, image, path string) error {
	// No socket or application startup: use the previous image's SQLite library read-only.
	_, err := d.command(ctx, "run", "--rm", "--network", "none", "--read-only", "--entrypoint", "node", "--mount", "type=bind,src="+path+",dst=/backup,readonly", image, "-e",
		`const fs=require('fs');if(!fs.existsSync('/backup/dockge.db'))process.exit(2);{const DB=require('better-sqlite3');const db=new DB('/backup/dockge.db',{readonly:true,fileMustExist:true});const rows=db.pragma('integrity_check');if(rows.length!==1||rows[0].integrity_check!=='ok')process.exit(1);db.close();}`)
	return err
}

// changedFields reports names, never environment values or file contents.
func changedFields(previous, target []byte) ([]string, error) {
	a, err := parseConfig(previous)
	if err != nil {
		return nil, err
	}
	b, err := parseConfig(target)
	if err != nil {
		return nil, err
	}
	keys := map[string]bool{}
	for key := range a.Services["dockge"] {
		keys[key] = true
	}
	for key := range b.Services["dockge"] {
		keys[key] = true
	}
	changed := []string{}
	for key := range keys {
		if stringMustJSON(a.Services["dockge"][key]) != stringMustJSON(b.Services["dockge"][key]) {
			changed = append(changed, key)
		}
	}
	sort.Strings(changed)
	return changed, nil
}

// otherWriters checks actual writable bind mounts, without reading other containers' environments.
func (d docker) otherWriters(ctx context.Context, self, dataDir string) error {
	output, err := d.command(ctx, "ps", "--no-trunc", "-q")
	if err != nil {
		return err
	}
	ids := []string{}
	for _, id := range strings.Fields(string(output)) {
		if id != self {
			ids = append(ids, id)
		}
	}
	if len(ids) == 0 {
		return nil
	}
	if len(ids) > 1024 {
		return errors.New("too many containers to establish exclusive data ownership")
	}
	args := append([]string{"inspect", "--format", "{{json .Mounts}}"}, ids...)
	output, err = d.command(ctx, args...)
	if err != nil {
		return err
	}
	decoder := json.NewDecoder(bytes.NewReader(output))
	for {
		var mounts []struct {
			Type   string
			Source string
			RW     bool
		}
		err = decoder.Decode(&mounts)
		if err == io.EOF {
			break
		}
		if err != nil {
			return err
		}
		for _, mount := range mounts {
			if mount.Type != "bind" || !mount.RW {
				continue
			}
			source := mount.Source
			if canonical, err := filepath.EvalSymlinks(source); err == nil {
				source = canonical
			}
			if within(source, dataDir) || within(dataDir, source) {
				return errors.New("another running container has writable access to panel data; establish one writer before updating")
			}
		}
	}
	return nil
}
