// 事件存储：journal 追加（写盘成功才算确认），snapshot 原子落盘（tmp + rename）。
// 内存状态仅为 journal 的 fold 结果；snapshot 失败不丢数据，按班次单恢复到最后确认步骤。
import { promises as fs } from "node:fs";
import { existsSync } from "node:fs";
import path from "node:path";
import { fold, initialState } from "./domain.js";

export class JournalWriteError extends Error {
  constructor(cause) {
    super("journal_write_failed");
    this.cause = cause;
  }
}
export class SnapshotWriteError extends Error {
  constructor(cause) {
    super("snapshot_write_failed");
    this.cause = cause;
  }
}

export class Store {
  constructor(dir, { now, fault = null } = {}) {
    this.dir = dir;
    this.journalPath = path.join(dir, "journal.log");
    this.snapshotPath = path.join(dir, "snapshot.json");
    this.tmpSuffix = ".tmp";
    this.now = now;
    // 一次性故障注入：nextWriteFail = "journal" | "snapshot" | null
    // 武装后，对应层的下一次写入强制失败，失败后自动解除（测试用）
    this.nextWriteFail = null;
    this._chain = Promise.resolve();
    this.state = initialState();
  }

  async init() {
    await fs.mkdir(this.dir, { recursive: true });
    let state = initialState();
    let fromSeq = 0;
    if (existsSync(this.snapshotPath)) {
      try {
        const snap = JSON.parse(await fs.readFile(this.snapshotPath, "utf8"));
        state = fold([], { ...initialState(), ...snap.state });
        fromSeq = snap.seq;
      } catch {
        state = initialState();
        fromSeq = 0;
      }
    }
    if (existsSync(this.journalPath)) {
      const raw = await fs.readFile(this.journalPath, "utf8");
      const lines = raw.split("\n").filter(Boolean);
      for (const line of lines) {
        const event = JSON.parse(line);
        if (event.seq > fromSeq) state = fold([event], state);
      }
    }
    this.state = state;
    return state;
  }

  // 串行执行：同机台并发提交按到达顺序裁决
  _serialize(fn) {
    const run = this._chain.then(() => fn());
    this._chain = run.catch(() => {});
    return run;
  }

  async appendJournal(events) {
    if (this.nextWriteFail === "journal") {
      this.nextWriteFail = null;
      throw new JournalWriteError(new Error("injected journal failure"));
    }
    let n = this.state.seq;
    const stamped = events.map(e => ({ ...e, seq: ++n, at: e.at || new Date().toISOString() }));
    const line = stamped.map(e => JSON.stringify(e)).join("\n") + "\n";
    await fs.appendFile(this.journalPath, line, "utf8");
    const handle = await fs.open(this.journalPath, "r+");
    try { await handle.sync(); } finally { await handle.close(); }
    return stamped;
  }

  async writeSnapshot() {
    if (this.nextWriteFail === "snapshot") {
      this.nextWriteFail = null;
      throw new SnapshotWriteError(new Error("injected snapshot failure"));
    }
    const persisted = { ...this.state };
    delete persisted._snapshotDirty; // 运行态标记不入库
    const tmp = this.snapshotPath + this.tmpSuffix;
    await fs.writeFile(tmp, JSON.stringify({ seq: this.state.seq, state: persisted }, null, 2), "utf8");
    const handle = await fs.open(tmp, "r+");
    try { await handle.sync(); } finally { await handle.close(); }
    await fs.rename(tmp, this.snapshotPath);
  }

  // 处理一个命令。key 缺省时不做幂等去重（只允许系统内部命令如迁移）。
  async handle(command, { idemKey } = {}) {
    return this._serialize(async () => {
      if (idemKey && this.state.idem[idemKey]) {
        const cached = this.state.idem[idemKey];
        return { ...cached, replayed: true };
      }
      // 先在草稿上验证并生成事件；校验失败（4xx）不落任何东西
      const draft = JSON.parse(JSON.stringify(this.state));
      let result;
      const { execute } = await import("./domain.js");
      result = execute(draft, command, { now: this.now });
      // journal 先落盘 —— 这一步失败表示未确认，内存不改，重试是安全的
      const stamped = await this.appendJournal(result.events);
      for (const e of stamped) this.state = fold([e], this.state);
      // 幂等回执一并 journal 化，重启仍去重
      if (idemKey) {
        const idemEvent = { type: "IDEM_STORED", key: idemKey,
          response: { status: result.status, body: result.body } };
        const [stampedIdem] = await this.appendJournal([idemEvent]);
        this.state = fold([stampedIdem], this.state);
      }
      // snapshot 失败不影响确认：journal 已持久，标记脏并上报，恢复/重试不会重放命令
      let snapshotError = null;
      try {
        await this.writeSnapshot();
      } catch (error) {
        snapshotError = error;
        this.state._snapshotDirty = true;
      }
      return { status: result.status, body: result.body, replayed: false,
        snapshotError: snapshotError ? snapshotError.message : null };
    });
  }

  // 按班次单恢复：从 journal 重放到最后确认事件，并重写 snapshot；不执行新命令，因此不会重复生成切片/步骤
  async recover() {
    return this._serialize(async () => {
      let state = initialState();
      if (existsSync(this.journalPath)) {
        const raw = await fs.readFile(this.journalPath, "utf8");
        const events = raw.split("\n").filter(Boolean).map(JSON.parse);
        state = fold(events, state);
      }
      this.state = state;
      await this.writeSnapshot();
      delete this.state._snapshotDirty;
      return state;
    });
  }
}
