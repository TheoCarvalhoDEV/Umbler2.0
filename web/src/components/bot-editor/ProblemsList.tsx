import type { GraphProblem } from '@talk/shared';
import { sectionTitle } from '../ui';

export interface ProblemsListProps {
  problems: GraphProblem[];
  onFocus(nodeId: string): void;
  labelOf?(nodeId: string): string;
}

export function ProblemsList({ problems, onFocus, labelOf }: ProblemsListProps) {
  if (problems.length === 0) return null;
  return (
    <section aria-label="Problemas do fluxo" className="p-4">
      <h2 className={`mb-3 ${sectionTitle} text-danger`}>{problems.length === 1 ? '1 problema' : `${problems.length} problemas`}</h2>
      <ul className="space-y-1.5 text-sm">
        {problems.map((p, i) => {
          const nodeId = p.nodeId;
          return (
            <li key={i} className="rounded-item bg-danger-soft text-danger">
              {nodeId ? (
                <button type="button" onClick={() => onFocus(nodeId)} className="w-full rounded-item px-3 py-2 text-left hover:underline">
                  {labelOf && <strong>{labelOf(nodeId)}:</strong>} {p.message}
                </button>
              ) : (
                <span className="block px-3 py-2">{p.message}</span>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
