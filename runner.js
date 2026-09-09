const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync, spawn } = require('child_process');

const ROOT = __dirname;
const UPSTREAM = path.join(os.tmpdir(), 'solana-trading-bot-v3-paper');
const UPSTREAM_REPO = 'https://github.com/wwwwwwworld/solana-trading-bot-v3.git';
const UPSTREAM_COMMIT = 'ee65514efe385a7d3f427a0130d4e2a1a2383a82';
const STATE = path.join(ROOT, 'data', 'paper-state.json');
const RUN_MINUTES = Number(process.env.PAPER_RUN_MINUTES || 330);

function sh(cmd, args, cwd) {
  execFileSync(cmd, args, { cwd, stdio: 'inherit', env: process.env });
}

function prepareUpstream() {
  fs.rmSync(UPSTREAM, { recursive: true, force: true });
  sh('git', ['clone', '--depth', '1', UPSTREAM_REPO, UPSTREAM]);
  sh('git', ['fetch', '--depth', '1', 'origin', UPSTREAM_COMMIT], UPSTREAM);
  sh('git', ['checkout', UPSTREAM_COMMIT], UPSTREAM);
  fs.mkdirSync(path.join(ROOT, 'data'), { recursive: true });
  fs.mkdirSync(path.join(UPSTREAM, 'data'), { recursive: true });
  if (fs.existsSync(STATE)) fs.copyFileSync(STATE, path.join(UPSTREAM, 'data', 'paper-state.json'));
  patchUpstream();
}

function patchUpstream() {
  const constants = path.join(UPSTREAM, 'helpers', 'constants.ts');
  let c = fs.readFileSync(constants, 'utf8');
  c = c.replace("export const PRIVATE_KEY = retrieveEnvVariable('PRIVATE_KEY', logger);", "export const PAPER_MODE = (process.env.PAPER_MODE || 'true') === 'true';\nexport const PRIVATE_KEY = PAPER_MODE ? '' : retrieveEnvVariable('PRIVATE_KEY', logger);");
  fs.writeFileSync(constants, c);

  const bot = path.join(UPSTREAM, 'bot.ts');
  let b = fs.readFileSync(bot, 'utf8');
  b = b.replace("import { JitoTransactionExecutor } from './transactions/jito-rpc-transaction-executor';", "import { JitoTransactionExecutor } from './transactions/jito-rpc-transaction-executor';\nimport { paperTrader } from './paper-trader';");
  b = b.replace("  async validate() {\n    try {", "  async validate() {\n    if (process.env.PAPER_MODE === 'true') {\n      logger.info('PAPER MODE: wallet validation skipped; no real wallet is loaded');\n      return true;\n    }\n\n    try {");
  const needle = "    const computedAmountOut = Liquidity.computeAmountOut({\n      poolKeys,\n      poolInfo,\n      amountIn,\n      currencyOut: tokenOut,\n      slippage: slippagePercent,\n    });\n\n    const latestBlockhash = await this.connection.getLatestBlockhash();";
  const replacement = "    const computedAmountOut = Liquidity.computeAmountOut({\n      poolKeys,\n      poolInfo,\n      amountIn,\n      currencyOut: tokenOut,\n      slippage: slippagePercent,\n    });\n\n    // Additive safety boundary: in Paper Mode the original strategy still computes\n    // the Raydium quote, but transaction construction/signing/submission is skipped.\n    if (process.env.PAPER_MODE === 'true') {\n      return paperTrader.execute({\n        direction,\n        poolKeys,\n        tokenIn,\n        tokenOut,\n        amountIn,\n        computedAmountOut: computedAmountOut.amountOut,\n        config: this.config,\n      });\n    }\n\n    const latestBlockhash = await this.connection.getLatestBlockhash();";
  if (!b.includes(needle)) throw new Error('Upstream bot.ts swap anchor was not found; refusing to patch.');
  b = b.replace(needle, replacement);
  fs.writeFileSync(bot, b);

  const index = path.join(UPSTREAM, 'index.ts');
  let i = fs.readFileSync(index, 'utf8');
  i = i.replace("  getWallet,", "  getWallet,");
  i = i.replace("  CONSECUTIVE_FILTER_MATCHES,", "  CONSECUTIVE_FILTER_MATCHES,\n  PAPER_MODE,");
  i = i.replace("  const wallet = getWallet(PRIVATE_KEY.trim());", "  const wallet = PAPER_MODE ? Keypair.generate() : getWallet(PRIVATE_KEY.trim());");
  i = i.replace("  logger.info('Bot is starting...');", "  logger.info('Bot is starting...');\n  if (PAPER_MODE) logger.warn('PAPER MODE ENABLED: real transaction submission is hard-blocked.');");
  fs.writeFileSync(index, i);

  fs.writeFileSync(path.join(UPSTREAM, 'paper-trader.ts'), paperTraderSource());
}

function paperTraderSource() {
  return String.raw`import fs from 'fs';
import path from 'path';
import { Liquidity, TokenAmount } from '@raydium-io/raydium-sdk';
import { logger } from './helpers';

const stateFile = process.env.PAPER_STATE_FILE || path.join(process.cwd(), 'data', 'paper-state.json');
const initialUsd = Number(process.env.PAPER_INITIAL_USD || 100);
const telegramToken = process.env.TELEGRAM_BOT_TOKEN || '';
const telegramChat = process.env.TELEGRAM_CHAT_ID || '';

interface Position {
  mint: string;
  amount: number;
  costQuote: number;
  entryQuotePerToken: number;
  openedAt: number;
}

interface Trade {
  id: number;
  side: 'BUY' | 'SELL';
  mint: string;
  amount: number;
  quote: number;
  price: number;
  pnl: number;
  reason: string;
  at: string;
}

interface PaperState {
  version: 1;
  initializedAt: string;
  initialUsd: number;
  initialSolUsd: number;
  initialQuote: number;
  cashQuote: number;
  realizedPnlQuote: number;
  trades: Trade[];
  positions: Record<string, Position>;
  nextTradeId: number;
}

function safeNum(x: any): number { return Number.parseFloat(String(x)); }
function money(x: number): string { return Number.isFinite(x) ? x.toFixed(8) : '0'; }

async function getSolUsd(): Promise<number> {
  const urls = [
    'https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd',
    'https://api.binance.com/api/v3/ticker/price?symbol=SOLUSDT',
  ];
  for (const url of urls) {
    try {
      const r = await fetch(url, { headers: { 'accept': 'application/json' } });
      if (!r.ok) continue;
      const j: any = await r.json();
      const price = j?.solana?.usd ?? j?.price;
      if (Number(price) > 0) return Number(price);
    } catch (_) {}
  }
  throw new Error('Cannot obtain SOL/USD price; refusing to invent the $100 conversion.');
}

async function telegram(text: string) {
  if (!telegramToken || !telegramChat) return;
  try {
    const r = await fetch('https://api.telegram.org/bot' + telegramToken + '/sendMessage', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: telegramChat, text }),
    });
    if (!r.ok) logger.warn({ status: r.status }, 'Telegram notification failed');
  } catch (e) {
    logger.warn({ error: e }, 'Telegram notification error');
  }
}

function readState(): PaperState | null {
  try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch (_) { return null; }
}
function writeState(s: PaperState) {
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  const tmp = stateFile + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2));
  fs.renameSync(tmp, stateFile);
}

class PaperTrader {
  private statePromise: Promise<PaperState>;

  constructor() {
    this.statePromise = this.load();
  }

  private async load(): Promise<PaperState> {
    const existing = readState();
    if (existing) return existing;
    const solUsd = await getSolUsd();
    const initialQuote = process.env.QUOTE_MINT === 'USDC' ? initialUsd : initialUsd / solUsd;
    const s: PaperState = {
      version: 1,
      initializedAt: new Date().toISOString(),
      initialUsd,
      initialSolUsd: solUsd,
      initialQuote,
      cashQuote: initialQuote,
      realizedPnlQuote: 0,
      trades: [],
      positions: {},
      nextTradeId: 1,
    };
    writeState(s);
    await telegram('🟢 PAPER SESSION START\nCapital: $' + initialUsd.toFixed(2) + '\nSOL/USD: $' + solUsd.toFixed(2) + '\nVirtual quote capital: ' + money(initialQuote));
    return s;
  }

  async execute(args: any): Promise<{ confirmed: boolean; signature?: string; error?: string }> {
    const s = await this.statePromise;
    const mint = args.poolKeys.baseMint.toString();
    const amountIn = safeNum(args.amountIn.toFixed());
    const amountOut = safeNum(args.computedAmountOut.toFixed());
    const quoteIsBase = args.direction === 'buy';

    if (quoteIsBase) {
      if (s.cashQuote + 1e-12 < amountIn) {
        logger.warn({ mint, cash: s.cashQuote, required: amountIn }, 'Paper BUY rejected: insufficient virtual capital');
        return { confirmed: false, error: 'insufficient virtual capital' };
      }
      const old = s.positions[mint];
      const totalAmount = (old?.amount || 0) + amountOut;
      const totalCost = (old?.costQuote || 0) + amountIn;
      s.cashQuote -= amountIn;
      s.positions[mint] = {
        mint,
        amount: totalAmount,
        costQuote: totalCost,
        entryQuotePerToken: totalCost / totalAmount,
        openedAt: old?.openedAt || Date.now(),
      };
      s.trades.push({ id: s.nextTradeId++, side: 'BUY', mint, amount: amountOut, quote: amountIn, price: amountIn / amountOut, pnl: 0, reason: 'original strategy BUY', at: new Date().toISOString() });
      writeState(s);
      await telegram('🟢 PAPER BUY\nMint: ' + mint + '\nSize: ' + money(amountOut) + '\nCost: ' + money(amountIn) + '\nCash left: ' + money(s.cashQuote) + '\nReason: original strategy BUY');

      if (args.config.autoSell) {
        await this.monitorAndSell(args, s.positions[mint]);
      }
      return { confirmed: true, signature: 'PAPER-' + Date.now() };
    }

    return this.closePosition(s, mint, amountIn, 'original strategy SELL');
  }

  private async monitorAndSell(args: any, position: Position) {
    const interval = Number(args.config.priceCheckInterval);
    const duration = Number(args.config.priceCheckDuration);
    if (interval === 0 || duration === 0) {
      await this.sellFromQuote(args, position, 'price checks disabled / immediate auto-sell');
      return;
    }
    const deadline = Date.now() + duration;
    while (Date.now() < deadline) {
      try {
        const poolInfo = await Liquidity.fetchInfo({ connection: args.config.__connection, poolKeys: args.poolKeys });
        const tokenIn = new TokenAmount(args.tokenIn, String(Math.max(0, Math.floor(position.amount * Math.pow(10, args.tokenIn.decimals)))), false);
        const quote = Liquidity.computeAmountOut({
          poolKeys: args.poolKeys,
          poolInfo,
          amountIn: tokenIn,
          currencyOut: args.config.quoteToken,
          slippage: args.config.__sellSlippage,
        }).amountOut;
        const current = safeNum(quote.toFixed());
        const tp = position.costQuote * (1 + Number(args.config.takeProfit) / 100);
        const sl = position.costQuote * (1 - Number(args.config.stopLoss) / 100);
        if (current >= tp) { await this.sellFromQuote(args, position, 'TAKE_PROFIT'); return; }
        if (current <= sl) { await this.sellFromQuote(args, position, 'STOP_LOSS'); return; }
      } catch (e) {
        logger.debug({ error: e, mint: position.mint }, 'Paper price check failed');
      }
      await new Promise(r => setTimeout(r, interval));
    }
    await this.sellFromQuote(args, position, 'PRICE_CHECK_TIMEOUT');
  }

  private async sellFromQuote(args: any, position: Position, reason: string) {
    try {
      const poolInfo = await Liquidity.fetchInfo({ connection: args.config.__connection, poolKeys: args.poolKeys });
      const tokenIn = new TokenAmount(args.tokenIn, String(Math.max(0, Math.floor(position.amount * Math.pow(10, args.tokenIn.decimals)))), false);
      const quote = Liquidity.computeAmountOut({
        poolKeys: args.poolKeys,
        poolInfo,
        amountIn: tokenIn,
        currencyOut: args.config.quoteToken,
        slippage: args.config.__sellSlippage,
      }).amountOut;
      const quoteOut = safeNum(quote.toFixed());
      const s = await this.statePromise;
      this.closePosition(s, position.mint, quoteOut, reason);
    } catch (e) {
      logger.warn({ error: e, mint: position.mint }, 'Paper auto-sell failed; position remains persisted');
    }
  }

  private async closePosition(s: PaperState, mint: string, quoteOut: number, reason: string): Promise<{ confirmed: boolean; signature?: string; error?: string }> {
    const p = s.positions[mint];
    if (!p) return { confirmed: false, error: 'paper position not found' };
    const pnl = quoteOut - p.costQuote;
    s.cashQuote += quoteOut;
    s.realizedPnlQuote += pnl;
    s.trades.push({ id: s.nextTradeId++, side: 'SELL', mint, amount: p.amount, quote: quoteOut, price: quoteOut / p.amount, pnl, reason, at: new Date().toISOString() });
    delete s.positions[mint];
    writeState(s);
    const wins = s.trades.filter(t => t.side === 'SELL' && t.pnl > 0).length;
    const losses = s.trades.filter(t => t.side === 'SELL' && t.pnl <= 0).length;
    await telegram((pnl >= 0 ? '🟢' : '🔴') + ' PAPER SELL\nMint: ' + mint + '\nExit: ' + money(quoteOut) + '\nP&L: ' + money(pnl) + '\nCash: ' + money(s.cashQuote) + '\nReason: ' + reason + '\nWins/Losses: ' + wins + '/' + losses);
    return { confirmed: true, signature: 'PAPER-' + Date.now() };
  }

  async summary() {
    const s = await this.statePromise;
    const sells = s.trades.filter(t => t.side === 'SELL');
    const wins = sells.filter(t => t.pnl > 0).length;
    const losses = sells.filter(t => t.pnl <= 0).length;
    const msg = '📊 PAPER SUMMARY\nCash: ' + money(s.cashQuote) + '\nRealized P&L: ' + money(s.realizedPnlQuote) + '\nClosed trades: ' + sells.length + '\nWins/Losses: ' + wins + '/' + losses + '\nOpen positions: ' + Object.keys(s.positions).length;
    logger.info(msg.replace(/\n/g, ' | '));
    await telegram(msg);
    writeState(s);
  }
}

export const paperTrader = new PaperTrader();
`;
}

async function main() {
  if (String(process.env.PAPER_MODE || 'true') !== 'true') {
    throw new Error('Safety stop: this repository is configured for PAPER_MODE=true only.');
  }
  process.env.PAPER_STATE_FILE = STATE;
  prepareUpstream();
  sh('npm', ['install', '--no-audit', '--no-fund'], UPSTREAM);
  sh('npm', ['run', 'tsc'], UPSTREAM);

  const env = { ...process.env, PAPER_MODE: 'true', PAPER_STATE_FILE: STATE };
  const child = spawn('npm', ['start'], { cwd: UPSTREAM, env, stdio: 'inherit' });
  const stop = () => { try { child.kill('SIGTERM'); } catch (_) {} };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  const timer = setTimeout(stop, RUN_MINUTES * 60 * 1000);
  const code = await new Promise(resolve => child.on('exit', c => resolve(c ?? 0)));
  clearTimeout(timer);
  fs.mkdirSync(path.dirname(STATE), { recursive: true });
  if (fs.existsSync(path.join(UPSTREAM, 'data', 'paper-state.json'))) fs.copyFileSync(path.join(UPSTREAM, 'data', 'paper-state.json'), STATE);
  process.exit(Number(code) === 0 ? 0 : 1);
}

main().catch(err => { console.error(err); process.exit(1); });
