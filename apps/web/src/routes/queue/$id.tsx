import { Card } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { getQueueStatusQueryOptions } from '@/queries/get-queue-status';
import { useQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { motion } from 'framer-motion';
import { Clock, Search, Trophy } from 'lucide-react';
import { useEffect, useState } from 'react';

export const Route = createFileRoute('/queue/$id')({
  component: RouteComponent,
});

function RouteComponent() {
  const { id } = Route.useParams();
  const { data: crawlData, isLoading } = useQuery(
    getQueueStatusQueryOptions(id),
  );
  const [elapsedTime, setElapsedTime] = useState(0);

  useEffect(() => {
    if (!crawlData?.startedAt || isLoading) return;
    const interval = setInterval(() => {
      const now = Date.now();
      const elapsed = Math.floor((now - crawlData.startedAt) / 1000);
      setElapsedTime(elapsed);
    }, 1000);

    return () => clearInterval(interval);
  }, [crawlData?.startedAt]);

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  const progressPercentage = Math.min(
    (crawlData?.matchesFetched / crawlData?.idsFound) * 100,
    100,
  );

  const containerVariants = {
    hidden: { opacity: 0 },
    visible: {
      opacity: 1,
      transition: {
        staggerChildren: 0.1,
        delayChildren: 0.2,
      },
    },
  };

  const itemVariants = {
    hidden: { opacity: 0, y: 20 },
    visible: {
      opacity: 1,
      y: 0,
      transition: {
        duration: 0.6,
        ease: 'easeOut',
      },
    },
  };

  if (isLoading) {
    return (
      <div className="min-h-screen bg-background gradient-mesh dark">
        <h1>Loading</h1>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background gradient-mesh dark">
      <div className="container mx-auto px-4 py-8">
        <motion.div
          variants={containerVariants}
          initial="hidden"
          animate="visible"
          className="max-w-3xl mx-auto space-y-8"
        >
          {/* Header */}
          <motion.div variants={itemVariants} className="text-center space-y-4">
            <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-primary/10 border border-primary/20">
              <div className="w-2 h-2 bg-primary rounded-full pulse-glow" />
              <span className="text-sm font-medium text-primary">
                Analyzing your matches
              </span>
            </div>
            <h1 className="text-4xl md:text-5xl font-bold text-balance">
              League of Legends
              <span className="block text-primary">Rewind</span>
            </h1>
            <p className="text-lg text-muted-foreground max-w-2xl mx-auto text-pretty">
              We're gathering all your matches from {crawlData.jobMapping.scope}{' '}
              to create your personalized rewind
            </p>
          </motion.div>

          {/* Main Progress Card */}
          <motion.div variants={itemVariants}>
            <Card className="p-8 bg-card/50 backdrop-blur-sm border-border/50">
              <div className="space-y-6">
                <div className="text-center space-y-2">
                  <h2 className="text-3xl font-bold">
                    {Math.round(progressPercentage)}%
                  </h2>
                  <p className="text-muted-foreground">
                    {crawlData.matchesFetched} of {crawlData.idsFound} matches
                    processed
                  </p>
                </div>

                <div className="space-y-3">
                  <Progress value={progressPercentage} className="h-4" />
                  <div className="flex justify-between text-sm text-muted-foreground">
                    <span>Started {formatTime(elapsedTime)} ago</span>
                    <span className="capitalize">
                      {crawlData.state === 'listing'
                        ? 'Finding matches'
                        : crawlData.state}
                    </span>
                  </div>
                </div>
              </div>
            </Card>
          </motion.div>

          <motion.div
            variants={itemVariants}
            className="grid grid-cols-1 md:grid-cols-3 gap-4"
          >
            <Card className="p-6 bg-card/30 backdrop-blur-sm border-border/50">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-primary/20">
                  <Search className="w-5 h-5 text-primary" />
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">Matches Found</p>
                  <p className="text-2xl font-bold">{crawlData.idsFound}</p>
                </div>
              </div>
            </Card>

            <Card className="p-6 bg-card/30 backdrop-blur-sm border-border/50">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-success/20">
                  <Trophy className="w-5 h-5 text-[color:var(--color-success)]" />
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">Processed</p>
                  <p className="text-2xl font-bold">
                    {crawlData.matchesFetched}
                  </p>
                </div>
              </div>
            </Card>

            <Card className="p-6 bg-card/30 backdrop-blur-sm border-border/50">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-blue/20">
                  <Clock className="w-5 h-5 text-[color:var(--color-blue)]" />
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">Time Elapsed</p>
                  <p className="text-2xl font-bold">
                    {formatTime(elapsedTime)}
                  </p>
                </div>
              </div>
            </Card>
          </motion.div>

          <motion.div variants={itemVariants}>
            <Card className="p-6 bg-card/30 backdrop-blur-sm border-border/50">
              <div className="text-center space-y-2">
                <h3 className="text-lg font-semibold">
                  Analyzing {crawlData.jobMapping.region.toUpperCase()} Region
                </h3>
                <p className="text-sm text-muted-foreground">
                  Searching through both Ranked Solo/Duo and Flex queues for the
                  complete picture
                </p>
              </div>
            </Card>
          </motion.div>

          {/* Footer */}
          <motion.div
            variants={itemVariants}
            className="text-center text-muted-foreground"
          >
            <p className="text-sm">
              Hang tight! Your personalized League of Legends rewind will be
              ready soon.
            </p>
          </motion.div>
        </motion.div>
      </div>
    </div>
  );
}
