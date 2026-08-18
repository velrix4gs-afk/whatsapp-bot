import type { WASocket, WAMessage } from "@whiskeysockets/baileys";
import fs from "fs";
import path from "path";
import os from "os";
import { CMD } from "../whatsapp-bot";

const COMMANDS_FILE = path.join(process.cwd(), "data", "custom-commands.json");

interface CustomCommand {
  prefix: string;       // e.g. ".ping"
  response: string;     // text to send back
  description?: string;
}

let _cache: CustomCommand[] | null = null;
let _mtime = 0;

export function loadCustomCommands(): CustomCommand[] {
  try {
    if (!fs.existsSync(COMMANDS_FILE)) {
      const defaults: CustomCommand[] = [
        { prefix: `${CMD}ping`,  response: "🏓 Pong! Bot is online.", description: "Ping the bot" },
        { prefix: `${CMD}about`, response: `🤖 I'm a WhatsApp bot powered by Baileys.\nSend *${CMD}help* to see all commands.`, description: "About this bot" },
        { prefix: `${CMD}time`,  response: `🕐 Server time: ${new Date().toUTCString()}`, description: "Show server time" },
      ];
      fs.mkdirSync(path.dirname(COMMANDS_FILE), { recursive: true });
      fs.writeFileSync(COMMANDS_FILE, JSON.stringify(defaults, null, 2));
      _cache = defaults;
      return defaults;
    }

    const stat = fs.statSync(COMMANDS_FILE);
    if (_cache && stat.mtimeMs === _mtime) return _cache;

    const raw = fs.readFileSync(COMMANDS_FILE, "utf8");
    _cache = JSON.parse(raw) as CustomCommand[];
    _mtime = stat.mtimeMs;
    return _cache;
  } catch {
    return _cache ?? [];
  }
}

export function getCommandsFile(): string {
  return COMMANDS_FILE;
}

export async function handleCustomCommands(
  sock: WASocket,
  msg: WAMessage,
  sender: string,
  addLog: (s: string) => void
): Promise<boolean> {
  const text = (
    msg.message?.conversation ??
    msg.message?.extendedTextMessage?.text ?? ""
  ).trim();

  // Only handle messages that start with the command prefix
  if (!text.startsWith(CMD)) return false;

  const commands = loadCustomCommands();

  for (const cmd of commands) {
    if (text.toLowerCase().startsWith(cmd.prefix.toLowerCase())) {
      try {
        // Allow dynamic time in responses
        const response = cmd.response.replace("{time}", new Date().toUTCString());
        await sock.sendMessage(sender, { text: response }, { quoted: msg });
        addLog(`Custom command "${cmd.prefix}" → ${sender}`);
      } catch (err) {
        addLog(`Custom command failed: ${(err as Error).message}`);
      }
      return true;
    }
  }
  return false;
}
