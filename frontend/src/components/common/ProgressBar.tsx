import React from 'react';

interface ProgressBarProps {
  value: number; // Current value
  max?: number;  // Max value, defaults to 100
  color?: string;
  className?: string;
}

const ProgressBar: React.FC<ProgressBarProps> = ({
  value,
  max = 100,
  color,
  className = '',
}) => {
  const percentage = max > 0 ? (value / max) * 100 : 0;

  const progressColor = color ? color :
    percentage < 30 ? 'bg-red-500' :
    percentage < 70 ? 'bg-yellow-500' :
    'bg-green-500';

  return (
    <div className={`w-full bg-gray-200 rounded-full h-4 ${className}`}>
      <div
        className={`h-4 rounded-full ${progressColor} transition-all duration-500 ease-out`}
        style={{ width: `${Math.min(percentage, 100)}%` }}
      ></div>
    </div>
  );
};

export default ProgressBar;
