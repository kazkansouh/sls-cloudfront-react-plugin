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

module.exports = async (serverless, template) => {
  const service = serverless.service
  const resources = {
    WebRootBucket: {
      Type: 'AWS::S3::Bucket',
      Properties: {
        PublicAccessBlockConfiguration: {
          BlockPublicAcls: true,
          BlockPublicPolicy: true,
          IgnorePublicAcls: true,
          RestrictPublicBuckets: true,
        },
      },
    },
    WebRootBucketOAI: {
      Type: 'AWS::CloudFront::CloudFrontOriginAccessIdentity',
      Properties: {
        CloudFrontOriginAccessIdentityConfig: {
          Comment:
            `${service.service} WebRootBucket (${service.provider.stage})`,
        },
      },
    },
    WebRootPolicy: {
      Type: 'AWS::S3::BucketPolicy',
      Properties: {
        Bucket: {
          Ref: 'WebRootBucket',
        },
        PolicyDocument: {
          Version: '2012-10-17',
          Statement: [
            {
              Action: ['s3:GetObject'],
              Effect: 'Allow',
              Principal: {
                CanonicalUser: {
                  'Fn::GetAtt': 'WebRootBucketOAI.S3CanonicalUserId',
                },
              },
              Resource: {
                'Fn::Sub': '${WebRootBucket.Arn}/*',
              },
            },
          ],
        },
      },
    },
    Webserver: {
      Type: 'AWS::CloudFront::Distribution',
      Properties: {
        DistributionConfig: {
          Aliases: [service.custom.CloudfrontReactPlugin.domainName],
          CustomErrorResponses: [
            {
              ErrorCachingMinTTL: 86400,
              ErrorCode: 404,
              ResponseCode: 200,
              ResponsePagePath: '/index.html',
            },
            {
              ErrorCachingMinTTL: 86400,
              ErrorCode: 403,
              ResponseCode: 200,
              ResponsePagePath: '/index.html',
            },
          ],
          DefaultCacheBehavior: {
            TargetOriginId: 'WebRoot',
            ViewerProtocolPolicy: 'redirect-to-https',
            CachePolicyId: 'b2884449-e4de-46a7-ac36-70bc7f1ddd6d',
          },
          DefaultRootObject: 'index.html',
          Enabled: true,
          HttpVersion: 'http2',
          Origins: [
            {
              DomainName: {
                'Fn::GetAtt': 'WebRootBucket.DomainName',
              },
              Id: 'WebRoot',
              S3OriginConfig: {
                OriginAccessIdentity: {
                  'Fn::Sub':
                    'origin-access-identity/cloudfront/${WebRootBucketOAI}',
                },
              },
            },
          ],
          PriceClass: 'PriceClass_100',
          ViewerCertificate: {
            AcmCertificateArn:
              service.custom.CloudfrontReactPlugin.certificateArn,
            MinimumProtocolVersion: 'TLSv1.2_2021',
            SslSupportMethod: 'sni-only',
          },
        },
      },
    },
    DnsRecord: {
      Type: 'AWS::Route53::RecordSet',
      Properties: {
        AliasTarget: {
          DNSName: {
            'Fn::GetAtt': 'Webserver.DomainName',
          },
          HostedZoneId: 'Z2FDTNDATAQYW2', /* cloudfront */
        },
        HostedZoneId: service.custom.CloudfrontReactPlugin.hostedZoneId,
        Name: service.custom.CloudfrontReactPlugin.domainName,
        Type: 'A',
      },
    },
    DnsRecord6: {
      Type: 'AWS::Route53::RecordSet',
      Properties: {
        AliasTarget: {
          DNSName: {
            'Fn::GetAtt': 'Webserver.DomainName',
          },
          HostedZoneId: 'Z2FDTNDATAQYW2', /* cloudfront */
        },
        HostedZoneId: service.custom.CloudfrontReactPlugin.hostedZoneId,
        Name: service.custom.CloudfrontReactPlugin.domainName,
        Type: 'AAAA',
      },
    },
  };

  Object.assign(
    template.Resources,
    resources
  )

  template.Outputs.WebRootBucketName = {
    Value: {
      Ref: 'WebRootBucket',
    },
  };
  template.Outputs.WebsiteDistributionId = {
    Value: {
      Ref: 'Webserver',
    },
  };
};
