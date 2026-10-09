/**
 * tools.ts — 工具注册表
 */
import type { Tool } from "./Tool.js";
import { FileReadTool } from "../tools/FileRead.js";
import { FileWriteTool } from "../tools/FileWrite.js";
import { FileEditTool } from "../tools/FileEdit.js";
import { MultiEditTool } from "../tools/MultiEdit.js";
import { GlobTool } from "../tools/Glob.js";
import { GrepTool } from "../tools/Grep.js";
import { BashTool } from "../tools/Bash.js";
import { GitStatusTool, GitDiffTool, GitCommitTool, GitUndoTool } from "../git/tools.js";
import { WebSearchTool, WebFetchTool } from "../tools/Web.js";
import { ImageReadTool, DocReadTool } from "../tools/DocRead.js";
import {
  RenameSymbolTool, ExtractFunctionTool, MoveFileTool,
  InlineVariableTool, ExtractConstantTool,
} from "../tools/Refactor.js";
import {
  CodeStatsTool, ListFunctionsTool, DependencyAnalysisTool,
  ComplexityAnalysisTool,
} from "../tools/Analysis.js";
import {
  PackageInstallTool, PackageUninstallTool, PackageListTool,
  RunScriptTool,
} from "../tools/PackageManager.js";
import { QuestionTool } from "../tools/Question.js";
import { TodoWriteTool } from "../tools/todo.js";
import { AgentTool } from "../tools/Agent.js";
import { RepoMapTool } from "../tools/RepoMap.js";
import { CompactContextTool } from "../tools/CompactContext.js";
import { RunTestsTool } from "../tools/test-run.js";
import { ToolSearchTool } from "./lazy-tools.js";

export function getDefaultTools(): Tool[] {
  return [
    FileReadTool, FileWriteTool, FileEditTool,
    GlobTool, GrepTool, BashTool,
    GitStatusTool, GitDiffTool,
    WebSearchTool, QuestionTool,
    TodoWriteTool,
    RunTestsTool,
    ToolSearchTool,
    AgentTool,
    RepoMapTool,
    CompactContextTool,
  ];
}

export function getExtraTools(): Tool[] {
  return [
    GitCommitTool, GitUndoTool,
    WebFetchTool,
    ImageReadTool, DocReadTool,
    MultiEditTool,
    RenameSymbolTool, ExtractFunctionTool, MoveFileTool,
    InlineVariableTool, ExtractConstantTool,
    CodeStatsTool, ListFunctionsTool, DependencyAnalysisTool, ComplexityAnalysisTool,
    PackageInstallTool, PackageUninstallTool, PackageListTool,
    RunScriptTool,
  ];
}

export function resolveExtraTools(): Tool[] {
  const raw = process.env.TUPIG_EXTRA_TOOLS;
  if (!raw || !raw.trim()) return [];
  const wanted = new Set(raw.split(",").map((s) => s.trim()).filter(Boolean));
  return getExtraTools().filter((t) => wanted.has(t.name));
}

export function getToolByName(tools: Tool[], name: string): Tool | undefined {
  return tools.find((t) => t.name === name || t.aliases?.includes(name));
}

