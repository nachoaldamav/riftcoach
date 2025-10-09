import { useChampion, useChampionImage } from '@/providers/data-dragon-provider';
import { Gamepad2 } from 'lucide-react';
import { useState } from 'react';

interface ChampionImageProps {
  championId: string | number;
  size?: 'sm' | 'md' | 'lg';
  imageType?: 'square' | 'loading' | 'splash';
  className?: string;
  showName?: boolean;
}

export const ChampionImage = ({
  championId,
  size = 'md',
  imageType = 'square',
  className = '',
  showName = false,
}: ChampionImageProps) => {
  const champion = useChampion(championId);
  const imageUrl = useChampionImage(championId, imageType);
  const [imageError, setImageError] = useState(false);
  const [imageLoading, setImageLoading] = useState(true);

  const sizeClasses = {
    sm: 'w-6 h-6',
    md: 'w-8 h-8',
    lg: 'w-12 h-12',
  };

  const handleImageError = () => {
    setImageError(true);
    setImageLoading(false);
  };

  const handleImageLoad = () => {
    setImageLoading(false);
  };

  // Fallback when no champion data or image error
  if (!champion || imageError || !imageUrl) {
    return (
      <div className={`${sizeClasses[size]} ${className} flex items-center gap-2`}>
        <div className={`${sizeClasses[size]} bg-slate-700 rounded border border-slate-600 flex items-center justify-center`}>
          <Gamepad2 className="w-3 h-3 text-slate-400" />
        </div>
        {showName && (
          <span className="text-sm text-slate-300">
            Champion {championId}
          </span>
        )}
      </div>
    );
  }

  return (
    <div className={`${className} flex items-center gap-2`}>
      <div className={`${sizeClasses[size]} relative`}>
        {imageLoading && (
          <div className={`${sizeClasses[size]} bg-slate-700 rounded border border-slate-600 flex items-center justify-center absolute inset-0`}>
            <Gamepad2 className="w-3 h-3 text-slate-400 animate-pulse" />
          </div>
        )}
        <img
          src={imageUrl}
          alt={champion.name}
          className={`${sizeClasses[size]} rounded border border-slate-600 object-cover ${imageLoading ? 'opacity-0' : 'opacity-100'} transition-opacity duration-200`}
          onError={handleImageError}
          onLoad={handleImageLoad}
        />
      </div>
      {showName && (
        <span className="text-sm text-slate-300">
          {champion.name}
        </span>
      )}
    </div>
  );
};