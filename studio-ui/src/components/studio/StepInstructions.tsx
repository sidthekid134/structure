/**
 * StepInstructions — renders a numbered list of step instructions.
 *
 * Highlights critical steps with warning badges and renders portal links.
 */

import { AlertTriangle, ExternalLink } from 'lucide-react';
import type { StepInstruction } from '../../hooks/useGuidedFlow';

interface StepInstructionsProps {
  instructions: StepInstruction[];
}

export function StepInstructions({ instructions }: StepInstructionsProps) {
  if (!instructions || instructions.length === 0) return null;

  return (
    <ol className="space-y-2">
      {instructions.map((instruction) => (
        <li key={instruction.number} className="flex gap-3">
          <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-gray-100 text-xs font-semibold text-gray-600">
            {instruction.number}
          </span>
          <div className="flex-1 space-y-1">
            <p className="text-sm text-gray-700">{instruction.text}</p>
            {instruction.url && (
              <a
                href={instruction.url}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1 text-xs text-blue-600 hover:underline"
              >
                <ExternalLink className="h-3 w-3" />
                Open link
              </a>
            )}
            {instruction.warning && (
              <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
                <p className="text-xs text-amber-800">{instruction.warning}</p>
              </div>
            )}
          </div>
        </li>
      ))}
    </ol>
  );
}
