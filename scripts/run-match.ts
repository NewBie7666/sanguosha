import { loadMatchConfig, parseCliArgs } from '../src/ai-match/config';
import { runMatch } from '../src/ai-match/matchRunner';

const HELP = `用法: pnpm match -- [选项]

选项:
  --config <路径>   YAML 配置 (默认 config/match.example.yaml)
  --player-a <名>   使用配置 profiles 中的模型覆盖 A
  --player-b <名>   使用配置 profiles 中的模型覆盖 B
  --games <数量>    第一阶段仅支持 1
  --seed <整数>     覆盖游戏随机种子
  --headless        无 UI 运行 (默认即无 UI)
  --help            显示帮助

示例:
  pnpm match -- --config config/match.example.yaml --games 1 --seed 42 --headless
`;

async function main(): Promise<void> {
  const overrides = parseCliArgs(process.argv.slice(2));
  if (overrides.help) {
    process.stdout.write(HELP);
    return;
  }
  const config = await loadMatchConfig(overrides);
  const summary = await runMatch(config, { onProgress: (message) => process.stdout.write(`${message}\n`) });
  process.stdout.write(`\n对局完成: ${summary['winner'] ?? '无胜者'}\n`);
  process.stdout.write(`战报目录: ${summary['run_dir']}\n`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`对局失败: ${message}\n`);
  process.exitCode = 1;
});
