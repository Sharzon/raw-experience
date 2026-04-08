/**
 * Subagent Extension - Generic subagent with nesting control
 * 
 * Provides a tool to spawn subagents (separate pi processes) with configurable
 * maximum nesting depth. Default maxDepth is 1, meaning only the main agent
 * can create subagents, but subagents cannot create further subagents.
 * 
 * Example:
 * - maxDepth = 1: agent → subagent (subagent cannot create more)
 * - maxDepth = 3: agent → subagent → subagent → subagent (but not deeper)
 * 
 * Features:
 * - Configurable max nesting depth
 * - Isolated context per subagent (separate pi process)
 * - Streaming output support
 * - Proper context usage tracking
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, AgentToolResult } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

// ============================================================================
// Types
// ============================================================================

interface SubagentResult {
	success: boolean;
	output: string;
	usage?: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		cost: number;
		turns: number;
	};
	error?: string;
}

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_MAX_DEPTH = 1;
const MAX_OUTPUT_LENGTH = 50000;

// Module-level state storage (survives across tool calls within same session)
let globalState: { remainingDepth: number } | null = null;

// ============================================================================
// Helper Functions
// ============================================================================

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

function formatUsage(usage: SubagentResult["usage"]): string {
	if (!usage) return "";
	const parts: string[] = [];
	if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	return parts.join(" ");
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	if (currentScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return { command: process.execPath, args };
	}

	return { command: "pi", args };
}

// ============================================================================
// State Management
// ============================================================================

function getOrCreateState(): { remainingDepth: number } {
	// Use module-level state for simplicity
	// State can be initialized from environment variable when running as subagent
	if (!globalState) {
		const envDepth = process.env.PI_SUBAGENT_REMAINING_DEPTH;
		const defaultDepth = process.env.PI_SUBAGENT_REMAINING_DEPTH ? undefined : DEFAULT_MAX_DEPTH;
		
		globalState = {
			remainingDepth: envDepth ? parseInt(envDepth, 10) : (defaultDepth ?? DEFAULT_MAX_DEPTH),
		};
		console.log(`[Subagent] State initialized: remainingDepth=${globalState.remainingDepth} (env: ${envDepth})`);
	}
	return globalState;
}

function getRemainingDepth(): number {
	const state = getOrCreateState();
	return state.remainingDepth;
}

function decrementDepth(): void {
	const state = getOrCreateState();
	if (state.remainingDepth > 0) {
		state.remainingDepth--;
	}
}

// ============================================================================
// Subagent Execution
// ============================================================================

async function runSubagent(
	cwd: string,
	task: string,
	options: {
		model?: string;
		tools?: string[];
		systemPrompt?: string;
		thinking?: string;
		remainingDepth?: number;
	},
	signal?: AbortSignal,
	onUpdate?: (partial: AgentToolResult<any>) => void,
): Promise<SubagentResult> {
	const args: string[] = ["--mode", "json", "-p", "--no-session"];

	// Load the subagent extension in child process
	const extensionPath = process.argv[1];
	if (extensionPath) {
		args.push("-e", extensionPath);
	}

	if (options.model) {
		args.push("--model", options.model);
	}
	if (options.tools && options.tools.length > 0) {
		args.push("--tools", options.tools.join(","));
	}
	if (options.thinking) {
		args.push("--thinking", options.thinking);
	}

	// Pass remaining depth to subagent via environment variable
	const env = { ...process.env };
	// Pass remaining depth - 1 (we're using one level for this call)
	if (options.remainingDepth !== undefined) {
		env.PI_SUBAGENT_REMAINING_DEPTH = String(Math.max(0, options.remainingDepth - 1));
	}
	
	console.log(`[Subagent] Spawning subagent with remainingDepth=${options.remainingDepth}, passing env with depth=${Math.max(0, (options.remainingDepth ?? 1) - 1)}`);

	// Write system prompt to temp file if provided
	let tmpPromptPath: string | null = null;
	if (options.systemPrompt) {
		const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-"));
		tmpPromptPath = path.join(tmpDir, "system-prompt.md");
		await fs.promises.writeFile(tmpPromptPath, options.systemPrompt, { encoding: "utf-8", mode: 0o600 });
		args.push("--append-system-prompt", tmpPromptPath);
	}

	args.push(task);

	return new Promise<SubagentResult>((resolve, reject) => {
		let buffer = "";
		let stderr = "";
		const messages: any[] = [];
		const usage = {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			cost: 0,
			turns: 0,
		};

		const invocation = getPiInvocation(args);
		const proc = spawn(invocation.command, invocation.args, {
			cwd,
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
			env,
		});

		const processLine = (line: string) => {
			if (!line.trim()) return;
			let event: any;
			try {
				event = JSON.parse(line);
			} catch {
				return;
			}

			if (event.type === "message_end" && event.message) {
				messages.push(event.message);

				if (event.message.role === "assistant") {
					usage.turns++;
					const msgUsage = event.message.usage;
					if (msgUsage) {
						usage.input += msgUsage.input || 0;
						usage.output += msgUsage.output || 0;
						usage.cacheRead += msgUsage.cacheRead || 0;
						usage.cacheWrite += msgUsage.cacheWrite || 0;
						usage.cost += msgUsage.cost?.total || 0;
					}
				}

				// Send update
				if (onUpdate) {
					const output = getFinalOutput(messages);
					onUpdate({
						content: [{ type: "text", text: output || "(running...)" }],
						details: { usage },
					});
				}
			}

			if (event.type === "tool_result_end" && event.message) {
				messages.push(event.message);
			}
		};

		proc.stdout.on("data", (data) => {
			buffer += data.toString();
			const lines = buffer.split("\n");
			buffer = lines.pop() || "";
			for (const line of lines) processLine(line);
		});

		proc.stderr.on("data", (data) => {
			stderr += data.toString();
		});

		const cleanup = async () => {
			if (tmpPromptPath) {
				try {
					await fs.promises.unlink(tmpPromptPath);
				} catch { /* ignore */ }
				try {
					await fs.promises.rmdir(path.dirname(tmpPromptPath));
				} catch { /* ignore */ }
			}
		};

		proc.on("close", async (code) => {
			if (buffer.trim()) processLine(buffer);
			await cleanup();

			if (code === 0) {
				const output = getFinalOutput(messages);
				resolve({
					success: true,
					output: output || "(no output)",
					usage,
				});
			} else {
				const output = getFinalOutput(messages);
				resolve({
					success: false,
					output: output || stderr || "(no output)",
					usage,
					error: `Exit code: ${code}`,
				});
			}
		});

		proc.on("error", async (err) => {
			await cleanup();
			reject(err);
		});

		if (signal) {
			const killProc = () => {
				proc.kill("SIGTERM");
				setTimeout(() => {
					if (!proc.killed) proc.kill("SIGKILL");
				}, 5000);
			};
			if (signal.aborted) killProc();
			else signal.addEventListener("abort", killProc, { once: true });
		}
	});
}

function getFinalOutput(messages: any[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") return part.text.slice(0, MAX_OUTPUT_LENGTH);
			}
		}
	}
	return "";
}

// ============================================================================
// Main Extension
// ============================================================================

export default function (pi: ExtensionAPI) {
	console.log("[Subagent] Extension loaded");

	// Default configuration
	let config = {
		maxDepth: DEFAULT_MAX_DEPTH,
	};

	// Try to load config - local first, then global
	// Use process.cwd() for initial load (project directory)
	const loadConfigFromPath = (configPath: string): number | null => {
		try {
			if (fs.existsSync(configPath)) {
				const loaded = JSON.parse(fs.readFileSync(configPath, "utf-8"));
				if (typeof loaded.maxDepth === "number" && loaded.maxDepth >= 1) {
					return loaded.maxDepth;
				}
			}
		} catch {
			// Ignore errors, will fall through to next option
		}
		return null;
	};

	// Priority: local > global > default
	// Use process.cwd() for initial config load (project directory)
	const initialCwd = process.cwd();
	const localPath = path.join(initialCwd, ".pi", "subagent-config.json");
	const globalPath = path.join(os.homedir(), ".pi", "agent", "subagent-config.json");

	const localDepth = loadConfigFromPath(localPath);
	const globalDepth = loadConfigFromPath(globalPath);

	if (localDepth !== null) {
		config.maxDepth = localDepth;
	} else if (globalDepth !== null) {
		config.maxDepth = globalDepth;
	}

	console.log(`[Subagent] Max depth: ${config.maxDepth}`);

	// Register the subagent tool
	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: [
			`Run a task in a separate subagent process with isolated context.`,
			`Maximum nesting depth is ${config.maxDepth} (default).`,
			`When depth limit is reached, subagent cannot create further subagents.`,
		].join(" "),
		parameters: Type.Object({
			task: Type.String({ description: "Task/prompt for the subagent to execute" }),
			model: Type.Optional(Type.String({ description: "Model to use (e.g., 'claude-sonnet-4-5')" })),
			tools: Type.Optional(Type.Array(Type.String(), { description: "List of tools to enable (default: all)" })),
			systemPrompt: Type.Optional(Type.String({ description: "Custom system prompt for the subagent" })),
			thinking: Type.Optional(Type.String({ description: "Thinking level: off, minimal, low, medium, high, xhigh" })),
			maxDepth: Type.Optional(Type.Integer({ description: `Override max depth (default: ${config.maxDepth})` })),
		}),

		async execute(_toolCallId, params, signal, onUpdate, _ctx) {
			const task = params.task;
			const maxDepth = params.maxDepth ?? config.maxDepth;

			// Get remaining depth
			const remainingDepth = getRemainingDepth();
			console.log(`[Subagent] execute: remainingDepth=${remainingDepth}, maxDepth=${maxDepth}`);

			// Check depth limit - if no remaining depth, can't create subagent
			if (remainingDepth <= 0) {
				return {
					content: [
						{
							type: "text" as const,
							text: `Subagent depth limit reached. No more subagents allowed.`,
						},
					],
					details: {
						maxDepth,
						remainingDepth,
						reason: "depth_limit_reached",
					},
					isError: true,
				};
			}

			// Decrement depth before execution (we're using one level)
			decrementDepth();

			try {
				// Run the subagent
				const result = await runSubagent(
					_ctx.cwd,
					task,
					{
						model: params.model,
						tools: params.tools,
						systemPrompt: params.systemPrompt,
						thinking: params.thinking,
						remainingDepth: remainingDepth - 1,
					},
					signal,
					onUpdate,
				);

				if (result.success) {
					return {
						content: [{ type: "text", text: result.output }],
						details: {
							maxDepth,
							remainingDepth: remainingDepth - 1,
							usage: result.usage,
						},
					};
				} else {
					return {
						content: [{ type: "text", text: result.output }],
						details: {
							maxDepth,
							remainingDepth: remainingDepth - 1,
							usage: result.usage,
							error: result.error,
						},
						isError: true,
					};
				}
			} finally {
				// Restore depth after execution
				getOrCreateState().remainingDepth = remainingDepth;
			}
		},
	});

	// Register configuration command
	pi.registerCommand("subagent-config", {
		description: "Show or update subagent configuration",
		handler: async (args: string, ctx) => {
			if (args) {
				// Try to set new maxDepth
				const newDepth = parseInt(args, 10);
				if (!isNaN(newDepth) && newDepth >= 1) {
					config.maxDepth = newDepth;
					
					// Save to config file
					const configPath = path.join(os.homedir(), ".pi", "agent", "subagent-config.json");
					await fs.promises.writeFile(configPath, JSON.stringify({ maxDepth: newDepth }, null, 2));
					
					ctx.ui.notify(`Subagent max depth set to ${newDepth}`, "info");
				} else {
					ctx.ui.notify(`Invalid depth value. Must be >= 1`, "error");
				}
			} else {
				// Show current config
				const remainingDepth = getRemainingDepth();
				ctx.ui.notify(
					`Max depth: ${config.maxDepth}, Remaining depth: ${remainingDepth}`,
					"info"
				);
			}
		},
	});

	// Clean up state on session start (fresh session = depth reset)
	pi.on("session_start", async () => {
		// Reset depth for new session ONLY if not set from env (i.e., not running as subagent)
		const envDepth = process.env.PI_SUBAGENT_REMAINING_DEPTH;
		if (!envDepth) {
			getOrCreateState().remainingDepth = config.maxDepth;
		}
	});

	console.log("[Subagent] Extension initialized");
}
