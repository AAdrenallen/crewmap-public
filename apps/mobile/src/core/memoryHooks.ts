import type { MemoryEvent } from '@crewmap/shared/memories';

/** Emotes I send, for trip memories (D68); set by Memories.start. A separate module keeps emotes.ts free of cycles. */
export const memoryHooks: { sent: (to: string, preset: MemoryEvent['preset']) => void } = { sent: () => undefined };
