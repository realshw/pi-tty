# pi-tty

A [Pi](https://github.com/earendil-works/pi) package giving the agent controlled
access to one terminal session you open yourself. Needs Pi 0.85.1+, Node 22+
and tmux. Outside a tmux session it does nothing.

The whole extension is a single `index.ts`: tmux owns the pty, and the data
plane is `send-keys` (write) plus `capture-pane` (read).

## Install

```bash
pi install git:github.com/realshw/pi-tty
```

## Use

- `/tty` — open the managed session. Switch to it and type `exit` to close.
  The tools below error until a session is open.
- `send_tty { text, enter? }` — type into the session; `enter: true` runs it.
- `recv_tty { since? }` — read output since the last call (`"all"` for the
  whole buffer).
