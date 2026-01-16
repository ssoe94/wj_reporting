import React, { useState, useEffect } from 'react';

interface DonutChartProps {
  progress: number; // 0 to 100
  actual: number;
  planned: number;
  size?: number;
  strokeWidth?: number;
  hideQuantity?: boolean;
}

const numberFormatter = new Intl.NumberFormat('ko-KR');

const DonutChart: React.FC<DonutChartProps> = ({
  progress,
  actual,
  planned,
  size = 120,
  strokeWidth = 10,
  hideQuantity = false,
}) => {
  const [displayProgress, setDisplayProgress] = useState(0);

  useEffect(() => {
    // Animate the progress bar on mount and when progress changes
    const animationTimeout = setTimeout(() => setDisplayProgress(progress), 150);
    return () => clearTimeout(animationTimeout);
  }, [progress]);

  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  // Use the animated progress for the offset calculation
  const offset = circumference - (displayProgress / 100) * circumference;

  const plannedQty = planned > 1000 ? `${(planned / 1000).toFixed(1)}k` : numberFormatter.format(planned);
  const actualQty = actual > 1000 ? `${(actual / 1000).toFixed(1)}k` : numberFormatter.format(actual);

  const progressColor = progress >= 100 ? 'text-green-500' : progress > 80 ? 'text-blue-500' : 'text-orange-500';

  return (
    <div className="relative flex flex-col items-center justify-center gap-1">
      <svg width={size} height={size} className="-rotate-90 transform">
        {/* Background Circle */}
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          stroke="currentColor"
          strokeWidth={strokeWidth}
          fill="transparent"
          className="text-gray-200"
        />
        {/* Progress Circle */}
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          stroke="currentColor"
          strokeWidth={strokeWidth}
          fill="transparent"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          className={`${progressColor} transition-all duration-700 ease-out`}
          strokeLinecap="round"
        />
      </svg>
      <div className="absolute flex flex-col items-center justify-center">
        <span className="text-lg font-bold text-gray-800">
          {Math.round(progress)}%
        </span>
        {!hideQuantity && (
          <span className="text-xs text-gray-500">
            {actualQty} / {plannedQty}
          </span>
        )}
      </div>
    </div>
  );
};

export default DonutChart;

