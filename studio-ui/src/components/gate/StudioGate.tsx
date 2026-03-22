import { useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import PlatformStudio from '../studio/PlatformStudio';
import { GitHubLoginPage } from './GitHubLoginPage';

/** Set to true to show the GitHub OAuth login gate; false = unauthenticated, user-inputted token only */
const SHOW_LOGIN_GATE = false;

export const StudioGate = () => {
  const [isAuthenticated, setIsAuthenticated] = useState(!SHOW_LOGIN_GATE);

  return (
    <AnimatePresence mode="wait">
      {!isAuthenticated ? (
        <motion.div
          key="login"
          initial={{ opacity: 1 }}
          exit={{ opacity: 0, scale: 1.02 }}
          transition={{ duration: 0.35, ease: 'easeIn' }}
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 50,
          }}
        >
          <GitHubLoginPage onAuthenticated={() => setIsAuthenticated(true)} />
        </motion.div>
      ) : (
        <motion.div
          key="studio"
          initial={{ opacity: 0, scale: 0.98 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.4, ease: 'easeOut' }}
          style={{
            width: '100%',
            height: '100%',
          }}
        >
          <PlatformStudio />
        </motion.div>
      )}
    </AnimatePresence>
  );
};

export default StudioGate;
