export const generateFifoQueueName = (queueName: string): string => {
  return queueName + '.fifo'
}

export const generateDlQueueName = (queueName: string): string => {
  return 'dlq-' + queueName
}
