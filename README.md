# Solana Paper Trading Runner

This repository is an additive runner around the pinned upstream `wwwwwwworld/solana-trading-bot-v3` source at commit `ee65514efe385a7d3f427a0130d4e2a1a2383a82`.

## Safety contract

- `PAPER_MODE=true` is mandatory.
- No private key is required or accepted in Paper Mode.
- The upstream strategy, filters, listeners and pool logic are not rewritten in this repository.
- At runtime the runner clones the pinned upstream source into a temporary directory and applies only the Paper Trading adapter.
- The adapter replaces transaction submission with virtual accounting; no Solana transaction is signed or broadcast.

## Added layer

- $100 initial virtual capital converted to SOL at session initialization.
- Virtual SOL cash, trade ledger, realized P&L, win/loss statistics and persistent state.
- Raydium pool quotes are used for simulated entry/exit valuation.
- Original TP/SL/price-check configuration is reused for Paper Trading.
- Telegram trade and summary notifications.
- GitHub Actions runner with state artifact handoff between runs.

## Telegram secrets

Create repository Actions secrets named `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`. The bot must be able to post to the target chat/channel. Telegram's Bot API provides `sendMessage` for text notifications.

No real wallet private key is needed for this setup.

## Running

Use GitHub Actions -> `Paper Trading` -> `Run workflow`.

The scheduled runner is intentionally below the 6-hour GitHub-hosted job limit and restarts through scheduled workflow runs. GitHub-hosted jobs have a 6-hour execution limit, so this is not presented as a single permanent process.
