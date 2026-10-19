// Clientes de AWS. En local apuntan a moto (AWS_ENDPOINT_URL); en AWS usan los endpoints reales.
import { SQSClient, SendMessageCommand, ReceiveMessageCommand, DeleteMessageCommand, ChangeMessageVisibilityCommand, type Message } from '@aws-sdk/client-sqs';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import {
  S3Client,
  PutObjectCommand,
  PutObjectTaggingCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { createReadStream, statSync } from 'node:fs';
import type { Config } from '../config.js';

function base(cfg: Config) {
  return {
    region: cfg.aws.region,
    endpoint: cfg.aws.endpoint,
    ...(cfg.aws.endpoint ? { credentials: { accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test', secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test' } } : {}),
  };
}

// ---------- Colas (SQS) ----------
export class Queue {
  private sqs: SQSClient;
  constructor(cfg: Config) {
    this.sqs = new SQSClient(base(cfg));
  }

  async send(queueUrl: string, body: unknown) {
    await this.sqs.send(new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: JSON.stringify(body) }));
  }

  /** Consumo con long polling. Solo se usa en local: en AWS SQS invoca directamente a la Lambda. */
  async receive(queueUrl: string, max = 10, waitSeconds = 10): Promise<Message[]> {
    const res = await this.sqs.send(
      new ReceiveMessageCommand({ QueueUrl: queueUrl, MaxNumberOfMessages: max, WaitTimeSeconds: waitSeconds, MessageSystemAttributeNames: ['ApproximateReceiveCount'] }),
    );
    return res.Messages ?? [];
  }

  async ack(queueUrl: string, receiptHandle: string) {
    await this.sqs.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: receiptHandle }));
  }

  /** Devuelve el mensaje a la cola para reintentarlo en N segundos. */
  async retryIn(queueUrl: string, receiptHandle: string, seconds: number) {
    await this.sqs.send(new ChangeMessageVisibilityCommand({ QueueUrl: queueUrl, ReceiptHandle: receiptHandle, VisibilityTimeout: seconds }));
  }
}

// ---------- Bus de eventos (EventBridge) ----------
export interface DomainEvent<T = Record<string, unknown>> {
  type: string;
  detail: T;
}

export class EventBus {
  private eb: EventBridgeClient;
  constructor(private cfg: Config) {
    this.eb = new EventBridgeClient(base(cfg));
  }

  async publish(type: string, detail: Record<string, unknown>) {
    const res = await this.eb.send(
      new PutEventsCommand({
        Entries: [{ EventBusName: this.cfg.resources.eventBusName, Source: 'streamnote.app', DetailType: type, Detail: JSON.stringify(detail) }],
      }),
    );
    if (res.FailedEntryCount) throw new Error(`EventBridge rechazó el evento ${type}`);
  }
}

// ---------- Almacenamiento de grabaciones (S3) ----------
export class Storage {
  private s3: S3Client;
  private publicS3: S3Client;
  constructor(private cfg: Config) {
    this.s3 = new S3Client({ ...base(cfg), forcePathStyle: !!cfg.aws.endpoint });
    // Las URL firmadas deben apuntar a la dirección que ve el navegador
    this.publicS3 = new S3Client({ ...base(cfg), endpoint: cfg.aws.publicS3Endpoint, forcePathStyle: !!cfg.aws.endpoint });
  }

  get bucket() {
    return this.cfg.resources.recordingsBucket;
  }

  async uploadFile(key: string, path: string, contentType: string, tags: Record<string, string>) {
    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: createReadStream(path),
        ContentLength: statSync(path).size,
        ContentType: contentType,
        Tagging: new URLSearchParams(tags).toString(),
      }),
    );
  }

  async setTags(key: string, tags: Record<string, string>) {
    await this.s3.send(
      new PutObjectTaggingCommand({ Bucket: this.bucket, Key: key, Tagging: { TagSet: Object.entries(tags).map(([Key, Value]) => ({ Key, Value })) } }),
    );
  }

  async exists(key: string) {
    try {
      await this.s3.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return true;
    } catch {
      return false;
    }
  }

  async delete(key: string) {
    await this.s3.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  /** En AWS esto sería una URL firmada de CloudFront; aquí, de S3. */
  async signedUrl(key: string, seconds = 3600) {
    return getSignedUrl(this.publicS3, new GetObjectCommand({ Bucket: this.bucket, Key: key }), { expiresIn: seconds });
  }
}

// ---------- Notificaciones (DynamoDB) ----------
export interface Notification {
  userId: string;
  sk: string;
  id: string;
  type: string;
  title: string;
  body: string;
  link?: string;
  createdAt: string;
  read: boolean;
}

export class NotificationStore {
  private doc: DynamoDBDocumentClient;
  constructor(private cfg: Config) {
    this.doc = DynamoDBDocumentClient.from(new DynamoDBClient(base(cfg)), { marshallOptions: { removeUndefinedValues: true } });
  }

  async put(n: Notification) {
    await this.doc.send(new PutCommand({ TableName: this.cfg.resources.notificationsTable, Item: n }));
  }

  async latest(userId: string, limit = 50): Promise<Notification[]> {
    const res = await this.doc.send(
      new QueryCommand({
        TableName: this.cfg.resources.notificationsTable,
        KeyConditionExpression: 'userId = :u',
        ExpressionAttributeValues: { ':u': userId },
        ScanIndexForward: false,
        Limit: limit,
      }),
    );
    return (res.Items ?? []) as Notification[];
  }

  async markRead(userId: string, sk: string) {
    await this.doc.send(
      new UpdateCommand({
        TableName: this.cfg.resources.notificationsTable,
        Key: { userId, sk },
        UpdateExpression: 'SET #r = :t',
        ExpressionAttributeNames: { '#r': 'read' },
        ExpressionAttributeValues: { ':t': true },
      }),
    );
  }
}
