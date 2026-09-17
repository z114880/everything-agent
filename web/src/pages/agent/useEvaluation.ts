import { useEffect, useState } from "react";
import { evaluationOverview, evaluationEvents, startEvaluation, cancelEvaluation, type EvaluationOverview, type EvaluationEvent } from "../../evaluation-api";
import { evaluationPlayback } from "../../evaluation-playback";

/** 独立订阅评估进度，聊天和 Consolidate 不会重置评估流程。 */
export function useEvaluation() {
  const [overview, setOverview] = useState<EvaluationOverview | null>(null);
  const [events, setEvents] = useState<EvaluationEvent[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let disposed = false, loading = false;
    async function poll() {
      if (loading) return; loading = true;
      try {
        const data = await evaluationOverview();
        const latest = data.active ?? data.runs[0];
        const records = latest ? await evaluationEvents(latest.id) : [];
        if (!disposed) { setOverview(data); setEvents(records); }
      } catch (e) { if (!disposed) setError(e instanceof Error ? e.message : "评估连接失败"); }
      finally { loading = false; }
    }
    void poll(); const timer = setInterval(() => void poll(), 2500);
    return () => { disposed = true; clearInterval(timer); };
  }, []);
  async function start() {
    setBusy(true); setError("");
    try { await startEvaluation(); setOverview(await evaluationOverview()); setEvents([]); }
    catch (e) { setError(e instanceof Error ? e.message : "评估启动失败"); }
    finally { setBusy(false); }
  }
  async function cancel() {
    if (!overview?.active) return;
    setBusy(true);
    try { await cancelEvaluation(overview.active.id); }
    catch (e) { setError(e instanceof Error ? e.message : "取消失败"); }
    finally { setBusy(false); }
  }
  const latest = overview?.active ?? overview?.runs[0];
  const status = latest ? overview?.active ? `评估中 ${latest.report.passed + latest.report.failed}/${latest.report.total}` : latest.status === "waiting_scores" ? "等待 Langfuse 评分" : latest.report.decision === "passed" ? "评估通过" : latest.report.decision === "failed" ? "评估未通过" : "评估证据不足" : "";
  return { ...evaluationPlayback(events), status, error, busy, running: Boolean(overview?.active), start, cancel };
}
