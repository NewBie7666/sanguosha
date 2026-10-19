// @vitest-environment jsdom
// useSkillActions readiness 回归:异步技能注册期间不暴露旧视角 action。
import { describe, it, expect, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useSkillActions } from '../../src/client/hooks/useSkillActions';
import * as skillActionRegistry from '../../src/client/skillActionRegistry';
import type { GameView } from '../../src/engine/types';

interface PendingRegistration {
  release: () => Promise<void>;
}

function makeView(
  players: Array<{ index: number; name: string; skills: string[] }>,
): GameView {
  return { players } as unknown as GameView;
}

async function releaseNext(pending: PendingRegistration[]): Promise<void> {
  await waitFor(() => expect(pending.length).toBeGreaterThan(0));
  const next = pending.shift();
  if (!next) throw new Error('expected a pending skill registration');
  await act(async () => {
    await next.release();
  });
}

describe('useSkillActions — registration readiness', () => {
  it('注册完成前为空,切换视角或技能集合时同步隐藏旧 actions', async () => {
    const pending: PendingRegistration[] = [];
    const originalRegister = skillActionRegistry.registerSkillActions;
    const registerSpy = vi.spyOn(skillActionRegistry, 'registerSkillActions')
      .mockImplementation((playerIndex, skillIds) => new Promise<void>((resolve) => {
        pending.push({
          release: async () => {
            await originalRegister(playerIndex, skillIds);
            resolve();
          },
        });
      }));

    try {
      const players = [
        { index: 0, name: '甲', skills: ['制衡'] },
        { index: 1, name: '乙', skills: ['仁德'] },
      ];
      const { result, rerender } = renderHook(
        ({ view, perspectiveIdx }: { view: GameView; perspectiveIdx: number }) =>
          useSkillActions(view, perspectiveIdx),
        { initialProps: { view: makeView(players), perspectiveIdx: 0 } },
      );

      expect(result.current.skillActions).toEqual([]);
      expect(result.current.skillActionsReady).toBe(false);

      await releaseNext(pending);
      await releaseNext(pending);
      await waitFor(() => expect(result.current.skillActionsReady).toBe(true));
      expect(result.current.skillActions.map((action) => action.ownerId)).toEqual([0]);

      rerender({ view: makeView(players), perspectiveIdx: 1 });
      expect(result.current.skillActions).toEqual([]);
      expect(result.current.skillActionsReady).toBe(false);

      await releaseNext(pending);
      await releaseNext(pending);
      await waitFor(() => expect(result.current.skillActionsReady).toBe(true));
      expect(result.current.skillActions.map((action) => action.ownerId)).toEqual([1]);

      const changedPlayers = [
        { index: 0, name: '甲', skills: ['制衡'] },
        { index: 2, name: '丙', skills: ['武圣'] },
      ];
      rerender({ view: makeView(changedPlayers), perspectiveIdx: 1 });
      expect(result.current.skillActions).toEqual([]);
      expect(result.current.skillActionsReady).toBe(false);

      await releaseNext(pending);
      await releaseNext(pending);
      await waitFor(() => expect(result.current.skillActionsReady).toBe(true));
      expect(registerSpy).toHaveBeenCalledWith(2, ['武圣']);
    } finally {
      registerSpy.mockRestore();
      skillActionRegistry.clearRegistry();
    }
  });
});
