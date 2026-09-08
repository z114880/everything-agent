# Skills

Skills 为本地个人助理提供可编辑、按需加载的过程知识。每个 Skill 的事实来源是：

```text
.everything/skills/<skill-name>/SKILL.md
```

`SKILL.md` 使用 `name` 和 `description` frontmatter，正文保存完整执行指令：

```markdown
---
name: "meeting-prep"
description: "准备会前材料和风险清单"
---

先读取议程，再整理参与人、决策点和待确认风险。
```

名称只能包含小写英文字母、数字和单个连字符，且必须与目录名一致。`SkillStore` 提供列表、读取、原子保存、重命名和删除；重命名移动完整目录，因此配套资源不会丢失。

Agent 每轮开始时重新读取目录，只把名称和描述加入 System Prompt。模型决定使用某项 Skill 后，必须调用 `read_skill` 获取正文。`skills_discovered` 和 `skill_loaded` 事件只记录目录元数据，`tool_completed` 也不会暴露 Skill 正文；实际模型请求仍遵循现有 trace 输入快照规则。
