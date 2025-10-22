import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { useDataDragon } from '@/providers/data-dragon-provider';
import type { BuildPath } from '@/queries/get-match-insights';
import { Avatar } from '@heroui/react';
import type React from 'react';

interface BuildPathRecommendationProps {
  buildPath: BuildPath;
  className?: string;
}

interface ItemSlotProps {
  itemIds: number[];
  label?: string;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}

const ItemSlot: React.FC<ItemSlotProps> = ({
  itemIds,
  label,
  size = 'md',
  className,
}) => {
  const { getItemImageUrl } = useDataDragon();
  const sizeClasses = {
    sm: 'w-8 h-8',
    md: 'w-10 h-10',
    lg: 'w-12 h-12',
  };

  return (
    <div className={cn('flex flex-col items-center gap-1', className)}>
      {label && (
        <span className="text-xs text-muted-foreground font-medium">
          {label}
        </span>
      )}
      <div className="flex gap-1">
        {itemIds.map((itemId) => (
          <Avatar
            key={itemId}
            isBordered
            radius="sm"
            className={sizeClasses[size]}
            src={getItemImageUrl(itemId)}
          />
        ))}
      </div>
    </div>
  );
};

interface BootsOptionProps {
  option: BuildPath['boots']['options'][0];
  isRecommended?: boolean;
}

const BootsOption: React.FC<BootsOptionProps> = ({ option, isRecommended }) => {
  const { getItemImageUrl } = useDataDragon();
  
  return (
    <div
      className={cn(
        'flex flex-col items-center gap-1 p-2 rounded-lg border transition-colors',
        isRecommended
          ? 'border-green-400 bg-green-50 dark:bg-green-900/20'
          : 'border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50',
      )}
    >
      <Avatar
        isBordered
        radius="sm"
        className={cn(
          'w-10 h-10',
          isRecommended
            ? 'border-green-400'
            : 'border-blue-400/30'
        )}
        src={getItemImageUrl(option.id)}
      />
      <span className="text-xs text-center text-muted-foreground max-w-20">
        {option.reason}
      </span>
      {isRecommended && (
        <div className="text-xs font-medium text-green-600 dark:text-green-400">
          Priority: {Math.round(option.priority * 100)}%
        </div>
      )}
    </div>
  );
};

interface CoreItemSlotProps {
  coreItem: BuildPath['core'][0];
}

const CoreItemSlot: React.FC<CoreItemSlotProps> = ({ coreItem }) => {
  const { getItemImageUrl } = useDataDragon();
  
  return (
    <div className="flex flex-col gap-2 p-3 border rounded-lg bg-card">
      <div className="flex items-center gap-2">
        <span className="text-sm font-semibold text-foreground">
          {coreItem.slot}
        </span>
        <ItemSlot itemIds={coreItem.primary} size="md" />
      </div>

      {coreItem.branches.length > 0 && (
        <div className="space-y-2">
          <span className="text-xs text-muted-foreground font-medium">
            Situational Options:
          </span>
          {coreItem.branches.map((branch) => (
            <div
              key={`${branch.label}-${branch.when || 'default'}`}
              className="pl-2 border-l-2 border-muted space-y-1"
            >
              <div className="flex items-center gap-2">
                <span className="text-xs font-medium text-foreground">
                  {branch.label}
                </span>
                {branch.when && (
                  <span className="text-xs text-muted-foreground">
                    ({branch.when})
                  </span>
                )}
              </div>
              <div className="flex gap-1">
                {branch.add.map((itemId) => (
                  <Avatar
                    key={itemId}
                    isBordered
                    radius="sm"
                    className="w-8 h-8"
                    src={getItemImageUrl(itemId)}
                  />
                ))}
              </div>
              <p className="text-xs text-muted-foreground">{branch.reason}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export const BuildPathRecommendation: React.FC<
  BuildPathRecommendationProps
> = ({ buildPath, className }) => {
  const { getItemImageUrl } = useDataDragon();
  const topBootsOption = buildPath.boots.options.reduce((prev, current) =>
    current.priority > prev.priority ? current : prev,
  );

  return (
    <Card className={cn('w-full', className)}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <span className="text-lg font-bold">AI Recommended Build Path</span>
          <div className="w-6 h-6 bg-gradient-to-br from-blue-500 to-purple-600 rounded-full flex items-center justify-center">
            <span className="text-xs text-white font-bold">AI</span>
          </div>
        </CardTitle>
      </CardHeader>

      <CardContent className="space-y-6">
        {/* Build Progression */}
        <div className="space-y-4">
          <h3 className="text-sm font-semibold text-foreground">
            Build Progression
          </h3>

          <div className="flex items-center gap-4 overflow-x-auto pb-2">
            {/* Starting Items */}
            <ItemSlot itemIds={buildPath.starting} label="Start" size="sm" />

            <div className="text-muted-foreground">→</div>

            {/* Early Items */}
            {buildPath.early.map((early) => (
              <div key={early.id} className="flex flex-col items-center gap-1">
                <ItemSlot itemIds={[early.id]} label="Early" size="md" />
                {early.note && (
                  <span className="text-xs text-muted-foreground max-w-16 text-center">
                    {early.note}
                  </span>
                )}
              </div>
            ))}

            <div className="text-muted-foreground">→</div>

            {/* Boots */}
            <ItemSlot itemIds={[topBootsOption.id]} label="Boots" size="md" />
          </div>
        </div>

        {/* Boots Options */}
        <div className="space-y-3">
          <h3 className="text-sm font-semibold text-foreground">
            Boots Options
          </h3>
          <div className="flex gap-2 overflow-x-auto pb-2">
            {buildPath.boots.options
              .sort((a, b) => b.priority - a.priority)
              .map((option, index) => (
                <BootsOption
                  key={option.id}
                  option={option}
                  isRecommended={index === 0}
                />
              ))}
          </div>
          {buildPath.boots.policyNote && (
            <p className="text-xs text-muted-foreground italic">
              {buildPath.boots.policyNote}
            </p>
          )}
        </div>

        {/* Core Items */}
        <div className="space-y-3">
          <h3 className="text-sm font-semibold text-foreground">Core Items</h3>
          <div className="grid gap-3">
            {buildPath.core.map((coreItem) => (
              <CoreItemSlot key={coreItem.slot} coreItem={coreItem} />
            ))}
          </div>
        </div>

        {/* Sell Order */}
        {buildPath.sellOrder.length > 0 && (
          <div className="space-y-2">
            <h3 className="text-sm font-semibold text-foreground">
              Late Game Sell Order
            </h3>
            <div className="flex gap-1">
              {buildPath.sellOrder.map((itemId) => (
                <Avatar
                  key={itemId}
                  isBordered
                  radius="sm"
                  className="w-8 h-8 border-red-400/50"
                  src={getItemImageUrl(itemId)}
                />
              ))}
            </div>
          </div>
        )}

        {/* Rationale */}
        <div className="space-y-2">
          <h3 className="text-sm font-semibold text-foreground">AI Analysis</h3>
          <p className="text-sm text-muted-foreground leading-relaxed">
            {buildPath.rationale}
          </p>
        </div>
      </CardContent>
    </Card>
  );
};
