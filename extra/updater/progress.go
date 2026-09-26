package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"runtime/debug"
	"strings"
	"time"
)

// Lines of --progress json, schema 1. The panel parses them with common/panel-update.ts;
// only ever extend them.
type phaseLine struct {
	Kind  string `json:"dockge2"`
	V     int    `json:"v"`
	Op    string `json:"op"`
	Phase string `json:"phase"`
	From  string `json:"from"`
	To    string `json:"to"`
	At    string `json:"at"`
}
type previewLine struct {
	Kind          string   `json:"dockge2"`
	V             int      `json:"v"`
	From          string   `json:"from"`
	To            string   `json:"to"`
	Channel       string   `json:"channel"`
	Fields        []string `json:"fields"`
	SchemaChanges bool     `json:"schemaChanges"`
}
type resultLine struct {
	Kind         string `json:"dockge2"`
	V            int    `json:"v"`
	Op           string `json:"op"`
	Outcome      string `json:"outcome"`
	Phase        string `json:"phase"`
	From         string `json:"from"`
	To           string `json:"to"`
	Error        string `json:"error,omitempty"`
	RestoredData *bool  `json:"restoredData,omitempty"`
}
type journalLine struct {
	Kind         string `json:"dockge2"`
	V            int    `json:"v"`
	Op           string `json:"op"`
	Phase        string `json:"phase"`
	From         string `json:"from"`
	To           string `json:"to"`
	Error        string `json:"error,omitempty"`
	RestoredData *bool  `json:"restoredData,omitempty"`
}

// report is what the result line is derived from: the last journal write of this run.
type report struct {
	op, phase, from, to    string
	noChange, restoredData bool
}

const maxErrorLength = 500

// cli runs one invocation. With --progress json stdout carries only JSON lines, and every
// update and dry run ends with exactly one result line, whatever path it leaves by.
func cli(ctx context.Context, args []string, stdout, stderr io.Writer, e *engine) int {
	if len(args) > 0 && args[0] == internalRestoreFlag {
		return internalRestore(ctx, args[1:], stderr)
	}
	o, err := arguments(args)
	if errors.Is(err, flag.ErrHelp) {
		return 0
	}
	e.out = stdout
	if o.progress == "json" {
		e.out, e.progress = stderr, stdout
	}
	if err == nil && (runtime.GOOS != "linux" || (runtime.GOARCH != "amd64" && runtime.GOARCH != "arm64")) {
		err = errors.New("Linux amd64/arm64 is required")
	}
	if err != nil {
		fmt.Fprintln(stderr, err)
		if v := strings.TrimPrefix(o.version, "v"); versionPattern.MatchString(v) {
			e.report.to = v
		}
		e.emit(e.result(o, err, false))
		return 2
	}
	err = e.executeReported(ctx, o)
	if err != nil {
		fmt.Fprintln(stderr, redact(err.Error()))
	}
	if !o.status {
		e.emit(e.result(o, err, ctx.Err() != nil))
	}
	if err != nil {
		return 1
	}
	return 0
}

// executeReported turns a panic into an error in progress mode, so that it still ends in a
// result line; the journal keeps whatever phase it reached.
func (e *engine) executeReported(ctx context.Context, o options) (err error) {
	if e.progress != nil {
		defer func() {
			if r := recover(); r != nil {
				fmt.Fprintf(e.out, "%s\n", debug.Stack())
				err = fmt.Errorf("internal updater error: %v", r)
			}
		}()
	}
	return e.execute(ctx, o)
}

func (e *engine) emit(line any) {
	if e.progress == nil {
		return
	}
	encoder := json.NewEncoder(e.progress)
	encoder.SetEscapeHTML(false)
	_ = encoder.Encode(line)
}

func previousVersion(op operation) string {
	if op.Previous == nil {
		return ""
	}
	return op.Previous.Version
}

// writeJournal is the only writer of operation.json. Every successful write is one phase line.
func (e *engine) writeJournal(state string, op operation) error {
	if err := writeJSON(filepath.Join(state, "operation.json"), op); err != nil {
		return err
	}
	e.report.op, e.report.phase = op.ID, op.Phase
	e.report.from, e.report.to = previousVersion(op), op.Target.Version
	e.emit(phaseLine{Kind: "phase", V: 1, Op: op.ID, Phase: op.Phase, From: e.report.from, To: e.report.to, At: time.Now().UTC().Format(time.RFC3339)})
	return nil
}

// result derives the outcome from the last phase this run wrote. A run that wrote none
// refused; a journal left on a running phase needs the host, like recovery-required.
func (e *engine) result(o options, err error, interrupted bool) resultLine {
	r := resultLine{Kind: "result", V: 1, Op: e.report.op, Phase: e.report.phase, From: e.report.from, To: e.report.to}
	switch {
	case err == nil && o.dryRun:
		r.Outcome = "previewed"
	case err == nil && e.report.noChange:
		r.Outcome = "no-change"
	case err == nil:
		r.Outcome = "success"
	case e.report.op == "":
		r.Outcome = "refused"
	default:
		switch e.report.phase {
		case "failed-before-cutover", "recovered", "recovery-required":
			r.Outcome = e.report.phase
		default:
			r.Outcome = "recovery-required"
		}
	}
	if err != nil {
		if interrupted {
			err = fmt.Errorf("interrupted by a signal: %w", err)
		}
		r.Error = publicError(err)
	}
	if r.Outcome == "recovered" {
		restored := e.report.restoredData
		r.RestoredData = &restored
	}
	return r
}

// publicError is an error as the panel may show it: without command output that can quote
// configuration values, redacted, on one line, bounded.
func publicError(err error) string {
	s := err.Error()
	var walk func(error)
	walk = func(err error) {
		if c, ok := err.(*commandError); ok {
			s = strings.ReplaceAll(s, c.Error(), c.public())
		}
		switch u := err.(type) {
		case interface{ Unwrap() error }:
			if inner := u.Unwrap(); inner != nil {
				walk(inner)
			}
		case interface{ Unwrap() []error }:
			for _, inner := range u.Unwrap() {
				walk(inner)
			}
		}
	}
	walk(err)
	return oneLine(s)
}

func oneLine(s string) string {
	s = strings.Join(strings.Fields(redact(s)), " ")
	if r := []rune(s); len(r) > maxErrorLength {
		s = string(r[:maxErrorLength-3]) + "..."
	}
	return s
}

// statusLine prints the journal for the panel. It reads one file and needs neither Docker
// nor a writable state directory; without a journal it prints nothing.
func (e *engine) statusLine(state string) error {
	path := filepath.Join(state, "operation.json")
	if _, err := os.Lstat(path); os.IsNotExist(err) {
		return nil
	}
	op, err := loadOperation(path)
	if err != nil {
		return err
	}
	line := journalLine{Kind: "journal", V: 1, Op: op.ID, Phase: op.Phase, From: previousVersion(op), To: op.Target.Version}
	if op.Error != "" {
		// The first line is the failing step; command output follows it.
		line.Error = oneLine(strings.SplitN(op.Error, "\n", 2)[0])
	}
	// Recovered is written only after the restore it records, so the flag is the fact.
	if op.Phase == "recovered" {
		restored := op.RestoreData
		line.RestoredData = &restored
	}
	e.emit(line)
	return nil
}
