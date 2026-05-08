/**
 * Simple in-memory job queue for async analysis tasks
 * This is suitable for development and small-scale production.
 * For larger scale, consider using Redis + Bull/BullMQ.
 */

type JobHandler = (jobId: string) => Promise<void>;

interface QueuedJob {
  id: string;
  address: string;
  handler: JobHandler;
  createdAt: Date;
  startedAt?: Date;
  completedAt?: Date;
  error?: Error;
}

class JobQueue {
  private queue: Map<string, QueuedJob> = new Map();
  private isProcessing = false;
  private concurrency = 1; // Process one job at a time to respect API rate limits

  /**
   * Add a job to the queue
   */
  addJob(jobId: string, address: string, handler: JobHandler): void {
    this.queue.set(jobId, {
      id: jobId,
      address,
      handler,
      createdAt: new Date(),
    });

    // Start processing if not already running
    this.processQueue();
  }

  /**
   * Process queued jobs
   */
  private async processQueue(): Promise<void> {
    if (this.isProcessing) {
      return;
    }

    this.isProcessing = true;

    try {
      while (this.queue.size > 0) {
        // Get the first job
        const [jobId, job] = Array.from(this.queue.entries())[0];

        try {
          job.startedAt = new Date();
          await job.handler(jobId);
          job.completedAt = new Date();
          this.queue.delete(jobId);
        } catch (error) {
          job.error = error instanceof Error ? error : new Error(String(error));
          console.error(`Job ${jobId} failed:`, job.error);
          this.queue.delete(jobId);
        }
      }
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * Get job status
   */
  getJobStatus(jobId: string): QueuedJob | undefined {
    return this.queue.get(jobId);
  }

  /**
   * Check if job is queued
   */
  isJobQueued(jobId: string): boolean {
    return this.queue.has(jobId);
  }
}

// Global job queue instance
export const jobQueue = new JobQueue();
