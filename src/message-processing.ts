/**
 * Pure decision function for cursor rollback/persist after agent execution.
 * Extracted from index.ts for testability.
 */

interface CursorDecision {
  shouldRollback: boolean;
  shouldEnqueue: boolean;
  shouldPersistTailDrain: boolean;
  shouldClearTailDrain: boolean;
  succeeded: boolean;
}

export function decideCursorAction(params: {
  hadError: boolean;
  hadSendError: boolean;
  outputSentToUser: boolean;
  truncated: boolean;
  isTailDrain: boolean;
  wasTailDrain: boolean;
}): CursorDecision {
  const { hadError, hadSendError, outputSentToUser, truncated, isTailDrain, wasTailDrain } = params;

  if (hadError) {
    if (outputSentToUser) {
      // Error but output was sent — don't rollback (would cause duplicates).
      return {
        shouldRollback: false,
        shouldEnqueue: truncated || isTailDrain,
        shouldPersistTailDrain: isTailDrain || wasTailDrain,
        shouldClearTailDrain: false,
        succeeded: true,
      };
    }
    // Error and no output — rollback cursor for retry.
    const clearTailDrain = truncated && !isTailDrain;
    return {
      shouldRollback: true,
      shouldEnqueue: false,
      shouldPersistTailDrain: isTailDrain || wasTailDrain || clearTailDrain,
      shouldClearTailDrain: clearTailDrain,
      succeeded: false,
    };
  }

  // Agent succeeded but all sends failed — rollback.
  if (hadSendError && !outputSentToUser) {
    const clearTailDrain = truncated && !isTailDrain;
    return {
      shouldRollback: true,
      shouldEnqueue: false,
      shouldPersistTailDrain: isTailDrain || wasTailDrain || clearTailDrain,
      shouldClearTailDrain: clearTailDrain,
      succeeded: false,
    };
  }

  // Success path.
  return {
    shouldRollback: false,
    shouldEnqueue: truncated || isTailDrain,
    shouldPersistTailDrain: isTailDrain || wasTailDrain,
    shouldClearTailDrain: false,
    succeeded: true,
  };
}
