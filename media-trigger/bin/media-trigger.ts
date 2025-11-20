#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { MediaTriggerStack } from '../lib/media-trigger-stack';

const app = new cdk.App();
new MediaTriggerStack(app, 'MediaTriggerStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT || 'default',
    region: process.env.CDK_DEFAULT_REGION || 'us-east-1',
  },
});

