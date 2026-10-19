// src/client/hooks/useSkillActions.ts
// 技能 action 注册表管理 hook。从 GameView.tsx 提取。
//
// view 变化时异步重新注册所有玩家的技能前端 actions(defineAction)。
// registerSkillActions 是 async:内部动态 import 技能模块并调用 onMount → defineAction,
// 必须 await 才能让 defineAction 完成,registry 才有内容。
//
// 设计:注册按 view.players 全量注册(所有 owner),读取只取当前 perspective 的 actions。
// registry 是全局单例,clearRegistry + 全量重注册保证视角切换时数据一致。

import { useState, useEffect, useRef } from 'react';
import type { GameView } from '../../engine/types';
import {
  getActionsForPlayer,
  registerSkillActions,
  clearRegistry,
  type SkillActionDef,
} from '../skillActionRegistry';

export interface UseSkillActionsResult {
  /** 当前视角玩家已注册的技能 actions(技能按钮区/装备技能按钮用) */
  skillActions: SkillActionDef[];
  /** 当前 players + perspective 的技能 action 是否已完成注册。 */
  skillActionsReady: boolean;
}

/**
 * 管理 skillActionRegistry 的注册生命周期。
 * @param view      引擎视图(取 players 注册 / perspective 取 actions)
 * @param perspectiveIdx 当前视角座次
 */
export function useSkillActions(view: GameView, perspectiveIdx: number): UseSkillActionsResult {
  // 注册 key 必须包含座次、名称、技能集合和视角:同名/同技能但座次变化时仍应
  // 重新绑定 owner;视角切换时旧 owner 的 action 也不能短暂泄漏到新视角。
  const skillActionsKey = JSON.stringify({
    perspectiveIdx,
    players: view.players.map((p) => ({ index: p.index, name: p.name, skills: p.skills })),
  });
  const playersRef = useRef(view.players);
  playersRef.current = view.players;
  const perspectiveRef = useRef(perspectiveIdx);
  perspectiveRef.current = perspectiveIdx;
  const [registered, setRegistered] = useState<{
    key: string | null;
    actions: SkillActionDef[];
    ready: boolean;
  }>({ key: null, actions: [], ready: false });

  useEffect(() => {
    let cancelled = false;
    const key = skillActionsKey;
    // effect 在当前 render 后才执行;render 阶段先通过 key 比较返回空 actions/false
    // ready,避免视角或技能集合切换时沿用上一组按钮。
    setRegistered({ key, actions: [], ready: false });
    clearRegistry();
    (async () => {
      for (const p of playersRef.current) {
        await registerSkillActions(p.index, p.skills);
      }
      if (!cancelled) {
        setRegistered({
          key,
          actions: getActionsForPlayer(perspectiveRef.current),
          ready: true,
        });
      }
    })();
    return () => {
      cancelled = true;
    };
    // 依赖只含 skillActionsKey(已编码 players 的 index/name/skills 组合)+ perspective,
    // 而非 view.players 引用:view 每次 WebSocket 消息都是全新对象,若依赖 view.players,
    // 每次 view 变化(即使仅血量/手牌变化)都会 clearRegistry + 全量异步重注册,
    // async 间隙 skillActions 短暂为空 → 技能按钮闪烁。skillActionsKey 不变时
    // index/name/skills/perspective 未变,无需重注册(registerSkillActions 只用 p.index 与 p.skills)。
  }, [skillActionsKey]);

  const current = registered.key === skillActionsKey;
  return {
    skillActions: current ? registered.actions : [],
    skillActionsReady: current && registered.ready,
  };
}
