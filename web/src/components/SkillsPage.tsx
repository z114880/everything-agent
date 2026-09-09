import { BookOpen, FileCode2, LoaderCircle, Plus, RefreshCw, Save, Sparkles, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { deleteSkill, loadSkills, saveSkill, type AgentSkill } from "../agent-api";
import { PageHeading } from "./PageHeading";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "./ui/alert-dialog";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Textarea } from "./ui/textarea";

interface SkillDraft {
  originalName?: string;
  name: string;
  description: string;
  instructions: string;
}

const EMPTY_DRAFT: SkillDraft = { name: "", description: "", instructions: "" };
const MINIMUM_REFRESH_DURATION_MS = 300;

/** 编辑 Agent Skills，并将变更同步到 `.everything/skills`。 */
export function SkillsPage() {
  const [skills, setSkills] = useState<AgentSkill[]>([]);
  const [draft, setDraft] = useState<SkillDraft>(EMPTY_DRAFT);
  const [savedDraft, setSavedDraft] = useState<SkillDraft>(EMPTY_DRAFT);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [messageIsError, setMessageIsError] = useState(false);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const dirty = useMemo(() => JSON.stringify(draft) !== JSON.stringify(savedDraft), [draft, savedDraft]);
  const isCreating = draft.originalName === undefined;
  const isInitialLoading = loading && skills.length === 0;

  const reload = async (preferredName?: string, minimumDurationMs = 0) => {
    const startedAt = Date.now();
    setMessage("");
    setMessageIsError(false);
    setLoading(true);
    try {
      const result = await loadSkills();
      setSkills(result.skills);
      const selected = result.skills.find((skill) => skill.name === preferredName)
        ?? result.skills.find((skill) => skill.name === draft.originalName)
        ?? result.skills[0];
      const next = selected ? toDraft(selected) : EMPTY_DRAFT;
      setDraft(next);
      setSavedDraft(next);
    } catch (error) {
      setMessage(errorMessage(error));
      setMessageIsError(true);
    } finally {
      const remainingDuration = minimumDurationMs - (Date.now() - startedAt);
      // 手动刷新过快时保留最短反馈周期，避免按钮状态一闪而过。
      if (remainingDuration > 0) await wait(remainingDuration);
      setLoading(false);
    }
  };

  useEffect(() => { void reload(); }, []);

  function select(skill: AgentSkill) {
    if (dirty && !window.confirm("当前修改尚未保存，确认放弃修改？")) return;
    const next = toDraft(skill);
    setDraft(next);
    setSavedDraft(next);
    setMessage("");
    setMessageIsError(false);
  }

  function create() {
    if (dirty && !window.confirm("当前修改尚未保存，确认放弃修改？")) return;
    setDraft(EMPTY_DRAFT);
    setSavedDraft(EMPTY_DRAFT);
    setMessage("");
    setMessageIsError(false);
    requestAnimationFrame(() => nameInputRef.current?.focus());
  }

  function refresh() {
    if (dirty && !window.confirm("当前修改尚未保存，确认从本地重新读取？")) return;
    void reload(undefined, MINIMUM_REFRESH_DURATION_MS);
  }

  async function persist() {
    setSaving(true);
    setMessage("");
    setMessageIsError(false);
    try {
      const result = await saveSkill(draft);
      await reload(result.skill.name);
      setMessage(`${result.skill.path} 已保存，下一轮 Agent 立即生效。`);
    } catch (error) {
      setMessage(errorMessage(error));
      setMessageIsError(true);
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!draft.originalName) return;
    setSaving(true);
    setMessage("");
    setMessageIsError(false);
    try {
      await deleteSkill(draft.originalName);
      await reload();
      setMessage("Skill 已删除。");
    } catch (error) {
      setMessage(errorMessage(error));
      setMessageIsError(true);
    } finally {
      setSaving(false);
    }
  }

  return <div className="content-wrap skills-page">
    <PageHeading eyebrow="Agent 能力 / 按需加载" title="Skills" description="管理 Agent 可发现并按需读取的本地技能。" actions={<Button disabled={loading || saving} onClick={create}><Plus size={14} /> 新建 Skill</Button>} />
    <div className="intro-note"><BookOpen size={16} /><p><strong>Skill 文件是唯一事实来源。</strong> 页面直接读写 <code>.everything/skills/&lt;skill-name&gt;/SKILL.md</code>；Agent 只接收名称和描述，决定使用后通过 <code>read_skill</code> 读取完整指令。</p></div>
    {message && <div className={messageIsError ? "error-message" : "skills-message"} role={messageIsError ? "alert" : "status"}>{message}</div>}
    <div className="skills-layout">
      <aside className="panel skills-list-panel">
        <div className="panel-header skills-list-header">
          <div><span>本地 Skills</span><small>{loading ? "正在同步" : `${skills.length} 个`}</small></div>
          <Button className="skills-refresh" variant="ghost" size="sm" aria-label={loading ? "正在重新读取 Skills" : "重新读取 Skills"} aria-busy={loading} disabled={loading || saving} onClick={refresh}>
            {loading ? <LoaderCircle className="animate-spin" size={14} /> : <RefreshCw size={14} />}
            <span>{loading ? "读取中" : "刷新"}</span>
          </Button>
        </div>
        <div className={`skills-list ${loading ? "is-loading" : ""}`} aria-busy={loading}>
          {loading && skills.length === 0 && <div className="skills-empty"><LoaderCircle className="animate-spin" size={18} /><span>正在读取本地 Skills…</span></div>}
          {!loading && skills.length === 0 && !isCreating && <div className="skills-empty">还没有 Skill。点击“新建 Skill”开始。</div>}
          {skills.map((skill) => <button type="button" key={skill.name} className={`skill-list-item ${draft.originalName === skill.name ? "active" : ""}`} aria-current={draft.originalName === skill.name ? "true" : undefined} onClick={() => select(skill)}>
            <FileCode2 size={15} /><span><strong>{skill.name}</strong><small>{skill.description}</small></span>
          </button>)}
          {isCreating && !loading && <div className="skill-list-item skill-list-item-draft active" aria-current="true"><Sparkles size={15} /><span><strong>未保存的新 Skill</strong><small>填写右侧内容并保存到本地</small></span></div>}
        </div>
      </aside>

      <section className="panel skill-editor-panel" data-mode={isInitialLoading ? "loading" : isCreating ? "create" : "edit"}>
        <div className="panel-header skill-editor-header">
          <div><span>{isInitialLoading ? <LoaderCircle className="animate-spin" size={15} /> : isCreating ? <Sparkles size={15} /> : <FileCode2 size={15} />}{isInitialLoading ? "读取 Skills" : isCreating ? "创建新 Skill" : draft.originalName}</span><small>{isInitialLoading ? "正在准备编辑器" : isCreating ? "新技能草稿" : "编辑本地文件"}</small></div>
          <code>{isInitialLoading ? ".everything/skills" : draft.name ? `.everything/skills/${draft.name}/SKILL.md` : ".everything/skills/<skill-name>/SKILL.md"}</code>
        </div>
        {isInitialLoading ? <div className="skill-editor-loading"><LoaderCircle className="animate-spin" size={22} /><span>正在从本地读取 Skill 文件…</span></div> : <>
          {isCreating && <div className="skill-create-note"><Sparkles size={16} /><div><strong>定义一个可复用能力</strong><span>清晰描述使用时机，并把执行步骤与边界写进 Instructions。</span></div></div>}
          <div className="skill-editor-fields">
            <label><span>Name</span><Input ref={nameInputRef} value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder="meeting-prep" spellCheck={false} /><small>仅限小写英文字母、数字和连字符；修改后会重命名目录。</small></label>
            <label><span>Description</span><Input value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} placeholder="何时以及为什么使用这个 Skill" /></label>
            <label className="skill-instructions-field"><span>Instructions</span><Textarea value={draft.instructions} onChange={(event) => setDraft({ ...draft, instructions: event.target.value })} placeholder="写下 Agent 使用此 Skill 时必须遵循的步骤、边界和输出要求…" spellCheck={false} /></label>
          </div>
          <footer className="skill-editor-actions">
            {draft.originalName && <DeleteSkillDialog name={draft.originalName} disabled={saving} onConfirm={() => void remove()} />}
            <span className={dirty ? "is-dirty" : ""}>{dirty && <i aria-hidden="true" />}{dirty ? "有未保存的修改" : draft.originalName ? "已与本地文件同步" : "填写完整后即可保存"}</span>
            <Button disabled={saving || !dirty || !draft.name.trim() || !draft.description.trim() || !draft.instructions.trim()} aria-busy={saving} onClick={() => void persist()}>{saving ? <LoaderCircle className="animate-spin" size={14} /> : <Save size={14} />} {saving ? "正在保存…" : "保存 Skill"}</Button>
          </footer>
        </>}
      </section>
    </div>
  </div>;
}

function DeleteSkillDialog({ name, disabled, onConfirm }: { name: string; disabled: boolean; onConfirm(): void }) {
  return <AlertDialog><AlertDialogTrigger asChild><Button variant="destructive-outline" size="sm" disabled={disabled}><Trash2 size={13} /> 删除</Button></AlertDialogTrigger><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>永久删除 {name}？</AlertDialogTitle><AlertDialogDescription>整个 <code>.everything/skills/{name}</code> 目录及其中的配套资源都会被删除，此操作无法撤销。</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>取消</AlertDialogCancel><AlertDialogAction onClick={onConfirm}>确认删除</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>;
}

function toDraft(skill: AgentSkill): SkillDraft {
  return { originalName: skill.name, name: skill.name, description: skill.description, instructions: skill.instructions };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function wait(durationMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}
