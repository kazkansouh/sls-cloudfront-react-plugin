/*
  Copyright (C) 2022  Karim Kanso

  This program is free software: you can redistribute it and/or modify
  it under the terms of the GNU General Public License as published by
  the Free Software Foundation, either version 3 of the License, or
  (at your option) any later version.

  This program is distributed in the hope that it will be useful,
  but WITHOUT ANY WARRANTY; without even the implied warranty of
  MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
  GNU General Public License for more details.

  You should have received a copy of the GNU General Public License
  along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

'use strict';

const cf = require('./cloudformation');
const chalk = require('chalk');
const path = require('path');
const { spawn } = require('child_process');

class CloudfrontReactPlugin {
  constructor(serverless, options) {
    this.serverless = serverless;
    this.options = options;
    this.provider = this.serverless.getProvider('aws');
    this._outputs = {};

    this.commands = {
      deploy: {
        commands: {
          react: {
            usage: 'Build and upload react application.',
            lifecycleEvents: ['build', 'sync', 'invalidate', 'info'],
            options: {
              'skip-build': {
                usage: 'Skip CRA build step.',
                shortcut: 'n',
                required: false,
                type: 'boolean',
              },
              'dry-run': {
                usage: 'Pass --dryrun flag to "aws s3 sync".',
                required: false,
                type: 'boolean',
              },
            },
          },
        },
      },
    };

    this.hooks = {
      'deploy:react:build': this.buildApp.bind(this),
      'deploy:react:sync': this.uploadApp.bind(this),
      'deploy:react:invalidate': this.invalidateApp.bind(this),
      'deploy:react:info': this.info.bind(this),
      'before:package:finalize': this.cloudformationTemplate.bind(this),
      'before:remove:remove': this.remove.bind(this),
      'after:aws:info:displayStackOutputs': this.info.bind(this),
      initialize: () => {
        if (!serverless.service.custom) {
          throw new Error(
            `Missing ${this.constructor.name} configuration from custom.`,
          );
        }
        this.config = serverless.service.custom.CloudfrontReactPlugin;
      },
    };

    const newCustomPropSchema = {
      type: 'object',
      properties: {
        [this.constructor.name]: {
          type: 'object',
          properties: {
            domainName: { type: 'string' },
            hostedZoneId: { type: 'string' },
            craDirectory: {
              type: 'string',
              description: 'location of an app created with: create-react-app',
            },
            craBuildDirectory: {
              type: 'string',
              description: 'location of build output of create-react-app',
            },
            certificateArn: {
              type: 'string',
              description: 'certificate arn located in us-east-1',
            },
            REACT_APP: {
              type: 'object',
              additionalProperties: {
                oneOf: [
                  {
                    type: 'object',
                    properties: {
                      stackName: { type: 'string' },
                      output: { type: 'string' },
                    },
                    required: ['output'],
                    additionalProperties: false,
                  },
                  {
                    type: 'string',
                  },
                ],
              },
            },
          },
          additionalProperties: false,
          oneOf: [
            {
              required: [
                'domainName',
                'hostedZoneId',
                'certificateArn',
                'craDirectory',
              ],
            },
            {
              required: [
                'domainName',
                'hostedZoneId',
                'certificateArn',
                'craBuildDirectory',
              ],
            },
          ],
        },
      },
      required: [this.constructor.name],
    };

    serverless.configSchemaHandler.defineCustomProperties(newCustomPropSchema);
  }

  /**
   * Inject cloudfront and s3 bucket into cloudformation template.
   */
  async cloudformationTemplate() {
    //console.dir(this.serverless.variables);
    const template =
      this.serverless.configurationInput.provider
        .compiledCloudFormationTemplate;
    await cf(this.serverless, template);
  }

  /**
   * Calls "npm start build" in the craDirectory
   * @returns {Promise<void>}
   */
  async buildApp() {
    if (this.config.craBuildDirectory) {
      this.serverless.cli.log(
        'craBuildDirectory defined, skipping CRA build process',
        this.constructor.name,
      );
      return;
    }
    // set build dir to default for cra
    this.config.craBuildDirectory = path.join(
      this.config.craDirectory,
      'build',
    );

    if (this.options['skip-build']) {
      return;
    }

    this.serverless.cli.log('Starting CRA build', this.constructor.name);

    // cra environment vars
    const env = {
      PUBLIC_URL: this._publicUrl(),
    };
    if (this.config.REACT_APP) {
      for (let [key, value] of Object.entries(this.config.REACT_APP)) {
        const name = `REACT_APP_${key}`;
        if (typeof value === 'object') {
          value = await this._getOutput(value.output, value.stackName);
        }
        env[name] = value;
      }
    }

    this.serverless.cli.log(
      'CRA environment variables:',
      this.constructor.name,
    );
    for (const [key, value] of Object.entries(env)) {
      this.serverless.cli.log(
        `  ${chalk.blue(key)}=${chalk.green(value)}`,
        this.constructor.name,
      );
    }

    // trigger build
    const code = await this._spawn('npm', ['run', 'build'], {
      cwd: this.config.craDirectory,
      env: Object.assign({}, process.env, env),
    });
    if (code !== 0) {
      throw new Error(`non-zero exit status from child build process: ${code}`);
    }
  }

  /**
   * Uses aws s3 cli to sync craBuildDirectory with bucket
   * @returns {Promise<void>}
   */
  async uploadApp() {
    const bucketName = await this._getOutput('WebRootBucketName');
    this.serverless.cli.log(
      `Starting upload to: ${bucketName}`,
      this.constructor.name,
    );

    const code = await this._spawn(
      'aws',
      ['s3', 'sync', '.', `s3://${bucketName}`, '--delete'].concat(
        this.options['dry-run'] ? ['--dryrun'] : [],
      ),
      {
        cwd: this.config.craBuildDirectory,
      },
    );
    if (code !== 0) {
      throw new Error(`Upload failed with non-zero status code: ${code}`);
    }
  }

  /**
   * Invalidates the whole cloudfront distribution.
   * @returns {Promise<void>}
   */
  async invalidateApp() {
    if (this.options['dry-run']) {
      return;
    }
    const distributionId = await this._getOutput('WebsiteDistributionId');
    this.serverless.cli.log(
      `Invalidating CloudFront distribution: ${distributionId}`,
      this.constructor.name,
    );

    const result = await this.provider.request(
      'CloudFront',
      'createInvalidation',
      {
        DistributionId: distributionId,
        InvalidationBatch: {
          CallerReference: Date.now().toString(),
          Paths: { Quantity: 1, Items: ['/*'] },
        },
      },
    );
    this.serverless.cli.log(
      `Created invalidation with id: ${result.Invalidation.Id}`,
      this.constructor.name,
    );
  }

  /**
   * Delete all items from webroot bucket
   * @returns {Promise<void>}
   */
  async remove() {
    const bucketName = await this._getOutput('WebRootBucketName');
    const param = { Bucket: bucketName };
    this.serverless.cli.log(
      `Deleting files from: ${bucketName}`,
      this.constructor.name,
    );

    do {
      const objects = await this.provider.request('S3', 'listObjectsV2', param);

      await this.provider.request('S3', 'deleteObjects', {
        Bucket: bucketName,
        Delete: { Objects: objects.Contents.map(({ Key }) => ({ Key })) },
      });

      param.ContinuationToken = objects.NextContinuationToken; // should only be set when IsTruncated===true
    } while (param.ContinuationToken);
  }

  info() {
    this.serverless.cli.consoleLog(
      `${chalk.yellow('CloudFront SPA:')} ${this._publicUrl()}`,
    );
  }

  _publicUrl() {
    return `https://${this.config.domainName}/`;
  }

  /**
   * Thin wrapper around child_process.spawn to cleanly write to stdout/stderr
   * and then return the exist code.
   *
   * @param {string} cmd command to execute
   * @param {string[]} args arguments
   * @param {*} opt
   * @returns {Promise<number>} status code
   */
  _spawn(cmd, args, opt) {
    this.serverless.cli.log(
      `Executing: ${cmd} ${args.join(' ')}`,
      this.constructor.name,
    );
    const p = spawn(cmd, args, opt);
    p.stdout.setEncoding('utf8');
    p.stdout.on('data', (data) => {
      data
        .replace(/\n$/, '')
        .split('\n')
        .forEach((line) => {
          this.serverless.cli.log(chalk.gray(line), this.constructor.name);
        });
    });

    p.stderr.setEncoding('utf8');
    p.stderr.on('data', (data) => {
      data
        .replace(/\n$/, '')
        .split('\n')
        .forEach((line) => {
          this.serverless.cli.log(chalk.red(line), this.constructor.name);
        });
    });

    return new Promise((resolve) => p.on('close', resolve));
  }

  /**
   * Caching utility function to lookup stack outputs.
   *
   * @param {string} name
   * @param {string | undefined} stackName
   * @returns {Promise<string>}
   */
  async _getOutput(name, stackName) {
    if (!stackName) {
      stackName = this.provider.naming.getStackName();
    }
    if (!name) {
      throw new Error('name is not defined');
    }
    if (!this._outputs[stackName]) {
      const result = await this.provider.request(
        'CloudFormation',
        'describeStacks',
        { StackName: stackName },
      );
      if (
        !result.Stacks ||
        result.Stacks.length === 0 ||
        !result.Stacks[0].Outputs
      ) {
        throw new Error(`Stack ${stackName} has no outputs.`);
      }
      this._outputs[stackName] = result.Stacks[0].Outputs;
    }
    const output = this._outputs[stackName].find(
      ({ OutputKey }) => OutputKey === name,
    );
    if (output) {
      return output.OutputValue;
    }
    throw new Error(`Output ${name} not found in stack ${stackName}`);
  }
}

module.exports = CloudfrontReactPlugin;
