# Upstream preservation

The real trading core is pinned to:

- Repository: `wwwwwwworld/solana-trading-bot-v3`
- Commit: `ee65514efe385a7d3f427a0130d4e2a1a2383a82`
- Version: `3.0.0`

The runner downloads that exact commit at execution time and applies only an additive adapter at the transaction boundary plus Paper Mode wallet validation bypass.

The upstream project defines the original pool listeners, filters, buy/sell logic, slippage, retry settings and take-profit/stop-loss calculations. Those source files are not copied into this repository and are not rewritten here; this keeps the pinned core auditable and makes upstream drift impossible unless the pinned commit is deliberately changed.

Paper Mode intercepts after the original Raydium quote is computed and before the original transaction is constructed, signed, or submitted. The real transaction executors remain present in the pinned upstream code but are unreachable while `PAPER_MODE=true`.
