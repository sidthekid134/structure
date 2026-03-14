export interface ProvisioningOperation {
  id: string;
  app_id: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  environment: 'dev' | 'preview' | 'production';
  created_at: Date;
  updated_at: Date;
  error_message?: string | null;
  lock_acquired_at?: Date | null;
}

export interface ProvisioningQueue {
  id: string;
  operation_id: string;
  adapter_name: string;
  position: number;
  status: 'queued' | 'processing' | 'completed' | 'failed';
  created_at: Date;
  updated_at: Date;
}

export interface ProvisioningDependency {
  id: string;
  operation_id: string;
  adapter_name: string;
  depends_on_adapter: string;
  created_at: Date;
}
