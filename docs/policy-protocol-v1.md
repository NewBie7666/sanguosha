# Sanguosha Policy Protocol v1

This protocol is the stable boundary between perception/data generation and any fast policy
implementation (Laya, Valen-style choice heads, a heuristic baseline, or another model).

## Rules

- Policy code consumes normalized public/visible state, never engine-private objects.
- Every decision carries an explicit list of concrete candidate actions.
- The selected action is represented by `chosen_action_id`, not free-form text.
- A row is trainable only when the selected action exists in the candidate set and the source
  explicitly marks the decision eligible.
- Unknown relations or unavailable fields stay unknown/null; adapters must not guess.

## Canonical row

```json
{
  "schema": "sanguosha-policy",
  "schema_version": "1.0",
  "sample_id": "engine-000001",
  "source": "engine",
  "state": {
    "source": "engine",
    "mode": "duel_1v1",
    "viewer_seat_id": "0",
    "current_player_seat_id": "0",
    "phase": "出牌",
    "round": 2,
    "self": {},
    "players": [],
    "pending": null
  },
  "legal_actions": [
    {
      "action_id": "action_001",
      "type": "play",
      "category": "play",
      "description": "使用【杀】 → B",
      "target_seat_ids": ["1"]
    }
  ],
  "chosen_action_id": "action_001",
  "training_ready": true,
  "exclusion_reasons": []
}
```

## Export self-play decisions

After a match creates `game.jsonl`:

```bash
pnpm policy:export output/<run>/game.jsonl
```

By default only trainable rows are written. Add `--include-unready` to retain excluded rows for
review and diagnostics.

The Python video dataset implements the same field names and version. Cross-repository fixtures
should be kept structurally identical before a policy model is trained.

The protocol layer has no model dependency; Laya or another policy backend is intentionally a later adapter.
