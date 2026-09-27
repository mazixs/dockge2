# A reproducible scene of the interface

Run: `npx vite --config test/visual/vite.config.ts`, address `http://localhost:5090`.

The scene uses the real Layout, Dashboard, StackInspector with its tabs, Compose, StackJournal, StackTerminals, StackProgress, NewStack and StackGitChanges. Five fixed stacks show a running stack, a stopped one, a failure, local edits and a Git update. Paperless repeats the service names, images, port and repository of the Sites mockup. No external Socket.IO and no Docker are connected; every operation is refused. A permanent label tells the scene from a working server. This directory is not part of the production build. The scene speaks Russian.

The tabs of a stack keep one grid: the main column and the source panel on the right. The log shows only the stack's output, and container shells live in the terminal tab. Files, file selection, secrets, log, terminal and source are panels of one anatomy, with a header of one height, a name with an icon and a caption under the body; there are no headings between the panels. Opening a shell from a service menu leads to the terminal tab and gives it the input at once.

The progress of a command is shown by the real line: the "Start" and "Restart" buttons and the actions of a service row print prerecorded compose output into the progress terminal, frame by frame, redrawing the block in place as a real terminal does. The line parses it into steps, stands under the stack header and stays visible on another tab, while the "State" column of the services table speaks the words of compose all along. The uptime-kuma stack always answers with a failure: it shows the red line, the red state of the web service and the window with the full output behind "Show the output". No container is touched.

The log output and the container shell are fake as well: the log lines are prerecorded, and the shell answers ls, pwd, whoami and env with a local echo. No command runs, and the first line of the session says so.

## Reference screenshots

```bash
npm run test:visual           # compare the screens with the references
npm run test:visual:approve   # re-approve the references - only when the look was changed on purpose
```

Both commands run in the pinned Playwright image (`run.sh`), the same one CI uses, so a machine needs Docker and nothing else. `design.spec.ts` takes fourteen screens in the light and dark themes at 1280 px and six of them on a 390 px phone. The references lie in `baseline/<project>/<screen>.png` and are committed: a screenshot without history has nothing to be compared with. The first run of a new screen records its reference and fails - not an error, but a request to look at what was recorded.

The scene is deterministic: there is no socket, the time is frozen by `page.clock.setFixedTime`, the theme is set explicitly, and animations are off while a screenshot is taken. A difference therefore means a change of markup, tokens or font. A reference is re-approved deliberately and by a separate command: a screenshot updated along with every change stops being a reference and catches nothing.

The same configuration runs three more specs that check behaviour rather than pixels: `state-matrix.spec.ts` checks that every state of the overview and the list is named in words, `editor-lock.spec.ts` that a locked editor takes no paste, cut or drop, and `modal-lifecycle.spec.ts` that a dialog unmounted while it opens, is open or closes releases its element and backdrop.

Check the overview `/stack/paperless`, the files `/stack/paperless/files`, the log `/stack/paperless/logs`, the terminal `/stack/paperless/terminal`, the comparison `/stack/paperless/git` and the create page `/new` in the dark and light themes, at widths of 390, 768, 1280 and 1440 px. Choosing a stack on a phone closes the list and moves the focus. The service menu, tab switching, opening a session, the progress line and the output window are checked here too. This scene checks the look and the transitions; saving and Docker are checked separately by real E2E and unit tests.
