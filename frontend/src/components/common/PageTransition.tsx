import { motion, useReducedMotion } from 'framer-motion';
import type { ReactNode } from 'react';

interface PageTransitionProps {
  children: ReactNode;
  className?: string;
}

const pageVariants = {
  initial: {
    opacity: 0
  },
  animate: {
    opacity: 1
  },
  exit: {
    opacity: 0
  }
};

const pageTransition = {
  duration: 0.16,
  ease: [0.4, 0, 0.2, 1] as const
};

export default function PageTransition({ children, className = '' }: PageTransitionProps) {
  const reducedMotion = useReducedMotion();

  return (
    <motion.div
      initial={reducedMotion ? false : "initial"}
      animate="animate"
      exit="exit"
      variants={reducedMotion ? undefined : pageVariants}
      transition={reducedMotion ? { duration: 0 } : pageTransition}
      className={`main-page-transition ${className}`.trim()}
    >
      {children}
    </motion.div>
  );
}
