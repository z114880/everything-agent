import { access, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_DESCRIPTION_LENGTH = 500;
const MAX_INSTRUCTIONS_LENGTH = 100_000;

/** 页面与 Agent 共同使用的 Skill 内容。 */
export interface AgentSkill {
  name: string;
  description: string;
  instructions: string;
  path: string;
}

/** 保存 Skill 时允许同时重命名原目录。 */
export interface SaveSkillInput {
  originalName?: string;
  name: string;
  description: string;
  instructions: string;
}

/** 管理 `.everything/skills`，所有路径都由受限名称派生。 */
export class SkillStore {
  readonly directory: string;

  constructor(everythingHome: string) {
    this.directory = join(everythingHome, "skills");
  }

  /** 列出有效 Skill；损坏的外部文件会显式报错，避免 Agent 静默忽略配置。 */
  async list(): Promise<AgentSkill[]> {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(this.directory, { withFileTypes: true });
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
    const names = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
    return Promise.all(names.map((name) => this.read(name)));
  }

  /** 按名称读取并验证 SKILL.md。 */
  async read(name: string): Promise<AgentSkill> {
    assertSkillName(name);
    const path = this.skillFile(name);
    let source: string;
    try {
      source = await readFile(path, "utf8");
    } catch (error) {
      if (isMissing(error)) throw new Error(`Skill 不存在：${name}`);
      throw error;
    }
    const parsed = parseSkillDocument(source);
    if (parsed.name !== name) throw new Error(`Skill ${name} 的 frontmatter name 必须与目录名一致`);
    return { ...parsed, path: `.everything/skills/${name}/SKILL.md` };
  }

  /** 新建或保存 Skill；重命名时完整保留目录中的配套资源。 */
  async save(input: SaveSkillInput): Promise<AgentSkill> {
    const skill = normalizeSkill(input);
    const originalName = input.originalName?.trim();
    if (originalName) assertSkillName(originalName);
    await mkdir(this.directory, { recursive: true });

    const targetDirectory = this.skillDirectory(skill.name);
    if (!originalName) {
      if (await exists(targetDirectory)) throw new Error(`Skill 已存在：${skill.name}`);
      await mkdir(targetDirectory);
    } else {
      const originalDirectory = this.skillDirectory(originalName);
      if (!await exists(originalDirectory)) throw new Error(`Skill 不存在：${originalName}`);
      if (originalName !== skill.name) {
        if (await exists(targetDirectory)) throw new Error(`Skill 已存在：${skill.name}`);
        await rename(originalDirectory, targetDirectory);
      }
    }

    await atomicWrite(this.skillFile(skill.name), serializeSkillDocument(skill));
    return this.read(skill.name);
  }

  /** 删除一个受限名称对应的 Skill 目录及其配套资源。 */
  async delete(name: string): Promise<void> {
    assertSkillName(name);
    const directory = this.skillDirectory(name);
    if (!await exists(directory)) throw new Error(`Skill 不存在：${name}`);
    await rm(directory, { recursive: true });
  }

  /** 生成供模型发现 Skill 的紧凑目录，不包含完整指令。 */
  async catalog(): Promise<string> {
    return formatSkillCatalog(await this.list());
  }

  private skillDirectory(name: string): string {
    return join(this.directory, name);
  }

  private skillFile(name: string): string {
    return join(this.skillDirectory(name), "SKILL.md");
  }
}

/** 将 Skill 列表格式化为不含正文的模型目录。 */
export function formatSkillCatalog(skills: readonly Pick<AgentSkill, "name" | "description">[]): string {
  if (skills.length === 0) return "";
  return [
    "## 可用 Skills",
    "以下是可按需使用的技能。决定使用某项技能后，必须先调用 read_skill 读取完整指令，并遵循其内容。",
    ...skills.map((skill) => `- ${skill.name}: ${skill.description}`),
  ].join("\n");
}

/** 解析项目约定的 Skill Markdown frontmatter。 */
export function parseSkillDocument(source: string): Omit<AgentSkill, "path"> {
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/);
  if (!match) throw new Error("SKILL.md 必须包含 name 和 description frontmatter");
  const metadata = new Map<string, string>();
  for (const line of match[1]!.split(/\r?\n/)) {
    const field = line.match(/^([a-zA-Z][a-zA-Z0-9_-]*):\s*(.*)$/);
    if (field) metadata.set(field[1]!, decodeScalar(field[2]!));
  }
  return normalizeSkill({
    name: metadata.get("name") ?? "",
    description: metadata.get("description") ?? "",
    instructions: match[2]!.trimEnd(),
  });
}

function normalizeSkill(input: Pick<SaveSkillInput, "name" | "description" | "instructions">): Omit<AgentSkill, "path"> {
  const name = input.name.trim();
  const description = input.description.trim();
  const instructions = input.instructions.trim();
  assertSkillName(name);
  if (!description) throw new TypeError("Skill description 不能为空");
  if (description.length > MAX_DESCRIPTION_LENGTH) throw new TypeError(`Skill description 不能超过 ${MAX_DESCRIPTION_LENGTH} 个字符`);
  if (/\r|\n/.test(description)) throw new TypeError("Skill description 必须是单行文本");
  if (!instructions) throw new TypeError("Skill instructions 不能为空");
  if (instructions.length > MAX_INSTRUCTIONS_LENGTH) throw new TypeError(`Skill instructions 不能超过 ${MAX_INSTRUCTIONS_LENGTH} 个字符`);
  return { name, description, instructions };
}

function assertSkillName(name: string): void {
  if (!SKILL_NAME.test(name)) {
    throw new TypeError("Skill name 只能使用小写英文字母、数字和单个连字符");
  }
}

function decodeScalar(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try { return JSON.parse(trimmed) as string; } catch { /* 交由普通文本处理。 */ }
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) return trimmed.slice(1, -1).replaceAll("''", "'");
  return trimmed;
}

function serializeSkillDocument(skill: Omit<AgentSkill, "path">): string {
  return `---\nname: ${JSON.stringify(skill.name)}\ndescription: ${JSON.stringify(skill.description)}\n---\n\n${skill.instructions}\n`;
}

async function atomicWrite(path: string, contents: string): Promise<void> {
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, contents, { encoding: "utf8", mode: 0o644 });
  await rename(temporary, path);
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

function isMissing(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}
