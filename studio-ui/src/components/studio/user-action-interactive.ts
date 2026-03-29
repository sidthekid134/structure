import type { InteractiveAction, UserActionNode } from './types';

export function effectiveUserActionInteractiveAction(
  node: UserActionNode,
): InteractiveAction | undefined {
  return node.interactiveAction;
}
