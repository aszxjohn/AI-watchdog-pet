"""How much each pet state is actually shown: replays every Claude Code transcript through the same rules as
Sources/SessionWatcher.swift (state(of:now:)) and counts, per state, the pet-seconds on screen, how many times a
pet entered it, and how many sessions ever showed it. Also counts the tool-error shakes and the entrances.

The app keeps no history, so this rebuilds it: a session is on screen while its transcript was written to in the
last `activeMinutes` (config.json), and its state at each second follows the records written up to then.

Each continuous stretch in one state is a "run"; their lengths tell how much of a state's animation is ever seen
(the animation starts over at every state change). The default step is the watcher's 1.5 s poll, so changes
shorter than that are missed here as they are in the app.

usage: python3 tools/state_stats.py [--since 2026-10-20] [--until 2026-10-31] [--step 1.5] [--json out.json]
"""
import argparse
import json
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

CONFIG = Path.home() / "Library/Application Support/GundamPet/config.json"
ASK = {"AskUserQuestion", "ExitPlanMode"}
SLOW = {"Agent", "Task", "Workflow", "WebSearch", "WebFetch", "Monitor", "TaskOutput", "ScheduleWakeup"}
STATES = ["waiting", "thinking", "working", "permission", "question", "done", "sleeping", "error"]
LABEL = {"waiting": "等你回覆", "thinking": "思考中", "working": "工作中", "permission": "要你批准?",
         "question": "要你決定", "done": "做完了", "sleeping": "休息中", "error": "出錯了"}


def ts_of(s):
    if not s:
        return None
    return datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()


def events(path):
    """The records the watcher reads, as (time, kind, data), in file order."""
    out = []
    with open(path, "rb") as f:
        for raw in f:
            try:
                o = json.loads(raw)
            except ValueError:
                continue
            if o.get("isSidechain"):
                continue
            typ = o.get("type")
            if typ not in ("user", "assistant", "system", "custom-title"):
                continue
            out.append((ts_of(o.get("timestamp")), typ, o))
    return out


class Tracker:
    def __init__(self):
        self.title = None
        self.pending = {}
        self.last_prompt_at = None
        self.turn_ended_at = None
        self.error_at = None
        self.tool_error_at = None
        self.last_record_at = None
        self.tool_errors = []

    def ingest(self, ts, typ, o):
        if typ == "custom-title":
            if o.get("customTitle"):
                self.title = o["customTitle"]
            return
        if typ == "user":
            self.user(ts, o)
        elif typ == "assistant":
            self.assistant(ts, o)
        elif typ == "system":
            if o.get("subtype") in ("stop_hook_summary", "turn_duration"):
                self.turn_ended_at = ts if ts is not None else self.last_record_at
                self.pending.clear()
        if ts is not None and typ in ("user", "assistant", "system"):
            self.last_record_at = ts if self.last_record_at is None else max(self.last_record_at, ts)

    def user(self, ts, o):
        content = (o.get("message") or {}).get("content")
        text = None
        if isinstance(content, str):
            text = content
        elif isinstance(content, list):
            saw, joined = False, ""
            for b in content:
                if not isinstance(b, dict):
                    continue
                if b.get("type") == "tool_result":
                    saw = True
                    self.pending.pop(b.get("tool_use_id"), None)
                    if b.get("is_error") is True:
                        self.tool_error_at = ts
                        self.tool_errors.append(ts)
                elif b.get("type") == "text":
                    joined += b.get("text") or ""
            if not saw and joined:
                text = joined
        if text is None or o.get("isMeta") is True:
            return
        if text.startswith("[Request interrupted"):
            self.pending.clear()
            self.turn_ended_at = ts
            return
        if text.startswith("<local-command"):
            return
        self.pending.clear()
        self.turn_ended_at = None
        self.error_at = None
        self.last_prompt_at = ts

    def assistant(self, ts, o):
        if o.get("isApiErrorMessage") is True:
            self.error_at = ts
        msg = o.get("message") or {}
        has_tool = False
        for b in msg.get("content") or []:
            if isinstance(b, dict) and b.get("type") == "tool_use":
                if b.get("id"):
                    self.pending[b["id"]] = (b.get("name") or "", ts)
                has_tool = True
        if has_tool:
            self.turn_ended_at = None
        elif msg.get("stop_reason") == "end_turn":
            self.turn_ended_at = ts

    def state(self, now, cfg):
        quiet = now - self.last_record_at
        asleep = quiet > cfg["sleepMinutes"] * 60
        if self.error_at is not None and self.error_at >= (self.last_prompt_at or -1e18) and not self.pending:
            return "sleeping" if asleep else "error"
        if self.pending:
            names = [n for n, _ in self.pending.values()]
            if any(n in ASK for n in names):
                return "question"
            oldest = min((a for _, a in self.pending.values() if a is not None), default=now)
            if quiet > cfg["permissionSeconds"] and now - oldest > cfg["permissionSeconds"] \
                    and not any(n in SLOW for n in names):
                return "permission"
            return "working"
        if self.turn_ended_at is not None:
            if now - self.turn_ended_at < 6:
                return "done"
            return "sleeping" if asleep else "waiting"
        if self.last_prompt_at is None or asleep:
            return "sleeping" if asleep else "waiting"
        return "thinking"


def replay(evs, cfg, step, since, until):
    """One transcript while it is on screen: {state: seconds}, entries, appearances, tool-error times, and the
    runs (state, seconds) — each stretch spent in one state without a break."""
    timed = sorted((e for e in evs if e[0] is not None and e[1] != "custom-title"), key=lambda e: e[0])
    if not timed:
        return None
    tr = Tracker()
    for e in evs:
        if e[1] == "custom-title":
            tr.ingest(None, *e[1:])     # the title only names the pet; it does not change the state
    secs, entries, runs = Counter(), Counter(), []
    run_len = 0.0
    active = cfg["activeMinutes"] * 60
    i, prev, appearances, shown = 0, None, 0, False
    t = timed[0][0]
    end = timed[-1][0] + active
    while t <= end:
        while i < len(timed) and timed[i][0] <= t:
            tr.ingest(*timed[i])
            i += 1
        visible = tr.last_record_at is not None and t - tr.last_record_at < active and since <= t < until
        if visible:
            s = tr.state(t, cfg)
            secs[s] += step
            if not shown:
                appearances += 1
            if s != prev or not shown:
                entries[s] += 1
                if prev is not None:
                    runs.append((prev, run_len))
                run_len = 0.0
            run_len += step
            prev, shown = s, True
            t += step
        else:
            if prev is not None:
                runs.append((prev, run_len))
            shown, prev, run_len = False, None, 0.0
            # jump to the next record instead of stepping through a long gap
            t = timed[i][0] if i < len(timed) else end + 1
    if prev is not None:
        runs.append((prev, run_len))
    errs = [e for e in tr.tool_errors if e is not None and since <= e < until]
    return secs, entries, appearances, errs, runs


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--since", default="2000-01-01")
    ap.add_argument("--until", default="2100-01-01")
    ap.add_argument("--step", type=float, default=1.5)
    ap.add_argument("--json")
    a = ap.parse_args()
    cfg = {"activeMinutes": 30, "sleepMinutes": 10, "permissionSeconds": 8,
           "projectsDir": "~/.claude/projects"}
    if CONFIG.exists():
        cfg.update(json.loads(CONFIG.read_text()))
    since = datetime.fromisoformat(a.since).replace(tzinfo=timezone.utc).timestamp() - 8 * 3600
    until = datetime.fromisoformat(a.until).replace(tzinfo=timezone.utc).timestamp() - 8 * 3600
    root = Path(cfg["projectsDir"]).expanduser()
    files = [p for p in root.glob("*/*.jsonl") if not p.name.startswith("agent-")]
    total, entries, sessions = Counter(), Counter(), Counter()
    per_day = defaultdict(Counter)
    appearances, shakes, used = 0, 0, 0
    runs = defaultdict(list)
    for p in files:
        r = replay(events(p), cfg, a.step, since, until)
        if not r:
            continue
        secs, ent, app, errs, rs = r
        for st, d in rs:
            runs[st].append(d)
        if not secs:
            continue
        used += 1
        total.update(secs)
        entries.update(ent)
        for s in secs:
            sessions[s] += 1
        appearances += app
        shakes += len(errs)
    def pct(xs, q):
        xs = sorted(xs)
        return xs[min(len(xs) - 1, int(q * len(xs)))] if xs else 0
    out = {"sessions": used, "appearances": appearances, "tool_error_shakes": shakes,
           "seconds": dict(total), "entries": dict(entries), "sessions_with": dict(sessions),
           "runs": {st: sorted(v) for st, v in runs.items()}}
    all_secs = sum(total.values()) or 1
    print(f"session 數 {used}，出場（進場動畫）{appearances} 次，工具出錯抖一下 {shakes} 次")
    print(f"{'狀態':<8}{'顯示時間(時)':>12}{'占比':>8}{'進入次數':>10}{'有出現的session':>16}")
    for s in sorted(STATES, key=lambda s: -total[s]):
        print(f"{LABEL[s]:<8}{total[s] / 3600:>12.1f}{total[s] / all_secs * 100:>7.1f}%{entries[s]:>10}{sessions[s]:>16}")
    print(f"\n每次停留多久（秒）")
    print(f"{'狀態':<8}{'次數':>8}{'中位數':>8}{'75%':>8}{'90%':>8}{'≥13秒':>8}")
    for s in sorted(STATES, key=lambda s: -total[s]):
        v = runs[s]
        long = sum(1 for d in v if d >= 13) / len(v) * 100 if v else 0
        print(f"{LABEL[s]:<8}{len(v):>8}{pct(v, .5):>8.1f}{pct(v, .75):>8.1f}{pct(v, .9):>8.1f}{long:>7.1f}%")
    if a.json:
        Path(a.json).write_text(json.dumps(out, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
