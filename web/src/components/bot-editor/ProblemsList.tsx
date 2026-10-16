import type { GraphProblem } from '@talk/shared';

export interface ProblemsListProps {
  problems: GraphProblem[];
  onFocus(nodeId: string): void;
  labelOf?(nodeId: string): string;
}

export function ProblemsList({ problems, onFocus, labelOf }: ProblemsListProps) {
  if (problems.length === 0) return null;
  return (
    <section aria-label="Problemas do fluxo" className="p-3">
      <h2 className="mb-2 text-sm font-semibold text-danger">{problems.length === 1 ? '1 problema' : `${problems.length} problemas`}</h2>
      <ul className="space-y-1 text-sm">
        {problems.map((p, i) => {
          const nodeId = p.nodeId;
          return (
            <li key={i}>
              {nodeId ? (
                <button type="button" onClick={() => onFocus(nodeId)} className="text-left hover:underline">
                  {labelOf && <strong>{labelOf(nodeId)}:</strong>} {p.message}
                </button>
              ) : (
                p.message
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
