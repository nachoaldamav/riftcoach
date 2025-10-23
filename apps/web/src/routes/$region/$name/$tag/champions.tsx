import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/$region/$name/$tag/champions')({
  component: ChampionsComponent,
});

function ChampionsComponent() {
  return (
    <div className="space-y-6">
      <div className="bg-neutral-900/50 rounded-lg border border-neutral-800 p-6">
        <h2 className="text-2xl font-bold text-white mb-4">Champion Statistics</h2>
        <p className="text-neutral-400">
          Champion performance analysis and statistics will be displayed here.
        </p>
      </div>
    </div>
  );
}
