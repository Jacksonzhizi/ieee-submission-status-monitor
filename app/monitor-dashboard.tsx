"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";

interface Monitor {
  id: string;
  journal_name: string;
  journal_slug: string;
  manuscript_url: string;
  username: string;
  notify_email: string;
  last_status: string | null;
  last_status_detail: string | null;
  last_checked_at: string | null;
  last_changed_at: string | null;
  check_count: number;
  enabled: number;
  created_at: string;
  updated_at: string;
}

interface StatusEvent {
  id: string;
  previous_status: string | null;
  current_status: string;
  detail: string | null;
  checked_at: string;
  notification_sent_at: string | null;
  notification_error: string | null;
}

const sampleJournal = "IEEE Transactions on Systems, Man, and Cybernetics: Systems";

function formatTime(value: string | null) {
  if (!value) return "尚未检测";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function eventSource(detail: string | null) {
  if (!detail) return "检测";
  const [source] = detail.split("：");
  return source || "检测";
}

export default function MonitorDashboard() {
  const [monitors, setMonitors] = useState<Monitor[]>([]);
  const [events, setEvents] = useState<Record<string, StatusEvent[]>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [form, setForm] = useState({
    journalName: sampleJournal,
    manuscriptUrl: "https://mc.manuscriptcentral.com/systems",
    username: "liuguanzhihit@163.com",
    password: "",
    notifyEmail: "2598900488@qq.com",
  });

  const journalCount = useMemo(
    () => new Set(monitors.map((monitor) => monitor.journal_slug)).size,
    [monitors]
  );

  async function loadMonitors() {
    const response = await fetch("/api/monitors");
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || "加载失败");
    setMonitors(body.monitors);
  }

  async function loadEvents(id: string) {
    const response = await fetch(`/api/monitors/${id}`);
    const body = await response.json();
    if (response.ok) {
      setEvents((current) => ({ ...current, [id]: body.events }));
    }
  }

  useEffect(() => {
    const timer = window.setTimeout(() => {
      loadMonitors().catch((error) => setMessage(error.message));
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    monitors.slice(0, 3).forEach((monitor) => {
      void loadEvents(monitor.id);
    });
  }, [monitors]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusyId("create");
    setMessage("");
    try {
      const response = await fetch("/api/monitors", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "保存失败");
      setForm((current) => ({ ...current, password: "" }));
      await loadMonitors();
      setMessage("监控任务已保存。");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "保存失败");
    } finally {
      setBusyId(null);
    }
  }

  async function checkNow(id: string) {
    setBusyId(id);
    setMessage("");
    try {
      const response = await fetch(`/api/monitors/${id}/check`, { method: "POST" });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "检测失败");
      await loadMonitors();
      await loadEvents(id);
      setMessage(body.result.changed ? "检测完成，状态已变化并记录。" : "检测完成，状态未变化。");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "检测失败");
    } finally {
      setBusyId(null);
    }
  }

  async function remove(id: string) {
    setBusyId(id);
    setMessage("");
    try {
      const response = await fetch(`/api/monitors/${id}`, { method: "DELETE" });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "删除失败");
      await loadMonitors();
      setMessage("监控任务已删除。");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "删除失败");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <main className="min-h-screen bg-[#f7f8f5] text-[#17211b]">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-8 px-5 py-6 sm:px-8 lg:px-10">
        <header className="flex flex-col gap-5 border-b border-[#d9ded4] pb-6 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p className="text-sm font-semibold text-[#60705f]">hits.asia</p>
            <h1 className="mt-2 max-w-3xl text-3xl font-semibold sm:text-4xl">
              IEEE 投稿状态识别系统
            </h1>
            <p className="mt-3 max-w-2xl text-base leading-7 text-[#58635a]">
              保存 ScholarOne 监控任务，每天北京时间 08:00 检测状态变化，并在变化时发送邮件通知。
            </p>
          </div>
          <div className="grid grid-cols-3 gap-3 text-center">
            <div className="border border-[#d9ded4] bg-white px-4 py-3">
              <div className="text-2xl font-semibold">{monitors.length}</div>
              <div className="text-xs text-[#60705f]">监控任务</div>
            </div>
            <div className="border border-[#d9ded4] bg-white px-4 py-3">
              <div className="text-2xl font-semibold">{journalCount}</div>
              <div className="text-xs text-[#60705f]">期刊种类</div>
            </div>
            <div className="border border-[#d9ded4] bg-white px-4 py-3">
              <div className="text-2xl font-semibold">08:00</div>
              <div className="text-xs text-[#60705f]">北京时间</div>
            </div>
          </div>
        </header>

        <section className="grid gap-6 lg:grid-cols-[420px_1fr]">
          <form onSubmit={submit} className="flex flex-col gap-4 border border-[#d9ded4] bg-white p-5">
            <div>
              <h2 className="text-lg font-semibold">新增投稿监控</h2>
              <p className="mt-1 text-sm text-[#60705f]">密码会在服务端加密保存，页面不会回显。</p>
            </div>

            <label className="grid gap-2 text-sm font-medium">
              期刊名称
              <input
                className="border border-[#cfd6ca] px-3 py-2 outline-none focus:border-[#1f6f4a]"
                value={form.journalName}
                onChange={(event) => setForm({ ...form, journalName: event.target.value })}
              />
            </label>

            <label className="grid gap-2 text-sm font-medium">
              投稿平台网址
              <input
                className="border border-[#cfd6ca] px-3 py-2 outline-none focus:border-[#1f6f4a]"
                value={form.manuscriptUrl}
                onChange={(event) => setForm({ ...form, manuscriptUrl: event.target.value })}
              />
            </label>

            <label className="grid gap-2 text-sm font-medium">
              ScholarOne 账号
              <input
                className="border border-[#cfd6ca] px-3 py-2 outline-none focus:border-[#1f6f4a]"
                value={form.username}
                onChange={(event) => setForm({ ...form, username: event.target.value })}
              />
            </label>

            <label className="grid gap-2 text-sm font-medium">
              ScholarOne 密码
              <input
                className="border border-[#cfd6ca] px-3 py-2 outline-none focus:border-[#1f6f4a]"
                type="password"
                autoComplete="new-password"
                value={form.password}
                onChange={(event) => setForm({ ...form, password: event.target.value })}
              />
            </label>

            <label className="grid gap-2 text-sm font-medium">
              通知邮箱
              <input
                className="border border-[#cfd6ca] px-3 py-2 outline-none focus:border-[#1f6f4a]"
                value={form.notifyEmail}
                onChange={(event) => setForm({ ...form, notifyEmail: event.target.value })}
              />
            </label>

            <div className="grid grid-cols-2 gap-3">
              <button
                type="button"
                className="border border-[#cfd6ca] px-3 py-2 text-sm font-semibold text-[#234033]"
                onClick={() =>
                  setForm({
                    ...form,
                    journalName: "IEEE Internet of Things Journal",
                    manuscriptUrl: "https://mc.manuscriptcentral.com/iot",
                  })
                }
              >
                切换 IoT 示例
              </button>
              <button
                className="bg-[#1f6f4a] px-3 py-2 text-sm font-semibold text-white disabled:opacity-60"
                disabled={busyId === "create"}
              >
                {busyId === "create" ? "保存中" : "保存监控"}
              </button>
            </div>

            {message ? (
              <div className="border border-[#d9ded4] bg-[#f7f8f5] px-3 py-2 text-sm text-[#485447]">
                {message}
              </div>
            ) : null}
          </form>

          <section className="flex flex-col gap-4">
            {monitors.length === 0 ? (
              <div className="border border-[#d9ded4] bg-white p-6 text-[#60705f]">
                还没有监控任务。保存左侧表单后，可以立即手动检测。
              </div>
            ) : null}

            {monitors.map((monitor) => (
              <article key={monitor.id} className="border border-[#d9ded4] bg-white p-5">
                <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
                  <div>
                    <h2 className="text-xl font-semibold">{monitor.journal_name}</h2>
                    <a
                      className="mt-1 block text-sm text-[#1f6f4a] underline-offset-4 hover:underline"
                      href={monitor.manuscript_url}
                      target="_blank"
                    >
                      {monitor.manuscript_url}
                    </a>
                    <div className="mt-4 grid gap-3 text-sm sm:grid-cols-3">
                      <div>
                        <div className="text-[#60705f]">当前状态</div>
                        <div className="mt-1 font-semibold">{monitor.last_status || "尚未检测"}</div>
                      </div>
                      <div>
                        <div className="text-[#60705f]">最近检测</div>
                        <div className="mt-1 font-semibold">{formatTime(monitor.last_checked_at)}</div>
                      </div>
                      <div>
                        <div className="text-[#60705f]">通知邮箱</div>
                        <div className="mt-1 font-semibold">{monitor.notify_email}</div>
                      </div>
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <button
                      className="bg-[#17211b] px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
                      disabled={busyId === monitor.id}
                      onClick={() => void checkNow(monitor.id)}
                    >
                      {busyId === monitor.id ? "检测中" : "手动检测"}
                    </button>
                    <button
                      className="border border-[#cfd6ca] px-4 py-2 text-sm font-semibold"
                      disabled={busyId === monitor.id}
                      onClick={() => void remove(monitor.id)}
                    >
                      删除
                    </button>
                  </div>
                </div>

                {monitor.last_status_detail ? (
                  <p className="mt-4 border-l-4 border-[#1f6f4a] bg-[#f7f8f5] px-3 py-2 text-sm text-[#485447]">
                    {monitor.last_status_detail}
                  </p>
                ) : null}

                <div className="mt-5 overflow-hidden border border-[#edf0ea]">
                  <div className="grid grid-cols-[0.9fr_0.8fr_1fr_1fr] bg-[#f7f8f5] px-3 py-2 text-xs font-semibold text-[#60705f]">
                    <span>检测时间</span>
                    <span>来源</span>
                    <span>原状态</span>
                    <span>当前状态</span>
                  </div>
                  {(events[monitor.id] || []).slice(0, 5).map((event) => (
                    <div
                      key={event.id}
                      className="grid grid-cols-[0.9fr_0.8fr_1fr_1fr] border-t border-[#edf0ea] px-3 py-2 text-sm"
                    >
                      <span>{formatTime(event.checked_at)}</span>
                      <span>{eventSource(event.detail)}</span>
                      <span>{event.previous_status || "首次检测"}</span>
                      <span>{event.current_status}</span>
                    </div>
                  ))}
                  {(events[monitor.id] || []).length === 0 ? (
                    <div className="px-3 py-3 text-sm text-[#60705f]">暂无检测历史。</div>
                  ) : null}
                </div>
              </article>
            ))}
          </section>
        </section>
      </div>
    </main>
  );
}
