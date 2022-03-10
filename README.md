# sls-cloudfront-react-plugin

Experimental plugin designed for deploying applications built with
`create-react-app` (CRA) to CloudFront distribution with a custom domain.

Plugin provides a CloudFormation template that includes the following resources:

* `WebRootBucket` private S3 bucket
* `Webserver` CloudFront distribution with CNAME
* `WebRootBucketOAI` and `WebRootPolicy` to grant CloudFront `GetObject`
  permission to the bucket.
* `DnsRecord` and `DnsRecord6` to direct custom domain to `Webserver`

## Dependencies

To use this plugin, its required to have a hosted zone in Route53. This means
that a domain name needs to be owned. Further, an ACM certificate is needed in
`us-east-1` (as per CloudFront requirements) that covers a required sub-domain.
To simplify the process its recommended to use a wildcard: E.g. _if you own
example.com, then a certificate such as *.example.com is required_.

Finally, is required to have a CRA application. This can be either in the same
location as a `serverless.yml` or completely separate. That is, this plugin can
be used to deploy a standalone CRA application or be integrated into the API's
`serverless.yml` so its possible to deploy a different frontend application for
each stage.

## Parameterised CRA Build

CRA allows for environment variables to be encoded into the React application at
build time. These variables start with `REACT_APP_`. The plugin sets these
variables before it builds the CRA. Thus, it can be used to parameterise the
React application with items such as API URL.

As the CRA is compiled after the serverless application has been deployed this
is implemented by allowing any `Output` from the CloudFormation template to be
be provided as a `REACT_APP_` environment variable.

## CLI Usage

The plugin hooks into the `before:package:finalize` lifecycle hook to inject
items into the CloudFormation template. Thus, the normal deployment process is
sufficient to create a CloudFront distribution hooked to a S3 bucket. However,
a second step is required to deploy the React application.

```plaintext
$ sls deploy react
```

This will enable run `npm run build` in the `craDirectory`, upload the resulting
build into the created S3 bucket and then invalidate the CloudFront
distribution.

When running `sls remove`, it will automatically remove all files from the S3
bucket before the stack is deleted.

## Example Config: Provide API URL

```yaml
service: example-1
frameworkVersion: '2'
provider:
  name: aws
  stage: dev
  runtime: nodejs14.x
  lambdaHashingVersion: 20201221
functions:
  hello:
    handler: handler.hello
    events:
      - httpApi: 'GET /api'
custom:
  CloudfrontReactPlugin:
    domainName: ${self:service}-${sls:stage}.example.com
    hostedZoneId: XXXX
    craDirectory: ../react-app
    certificateArn: arn:aws:acm:us-east-1:YYYY
    REACT_APP:
      NAME: ${self:service}-${sls:stage}
      API_URL:
        output: ServiceEndpoint
```

Here it is assumed that the domain `example.com` is hosted in Route53 with the
zone id: `XXXX`. Further, there is a certificate with arn
`arn:aws:acm:us-east-1:YYYY` located in `us-east-1` and covers the defined
domain name, either via a wildcard or sufficient subject alternative names for
each stage.

It also assumes there is a React application created with `create-react-app`
located in `../react-app`. This app makes use of the environment variable
`REACT_APP_API_URL`. This environment variable will be set to the URL of the
`httpApi` endpoint by looking up `ServiceEndpoint` from the CloudFormation stack
outputs.

## Example Config: Cognito

It is also possible use this plugin to deploy a React application
which uses OIDC against Cognito. The following is a rough example, and
assumes that there is already a user pool created with id `ZZZZ`. It
will create a new client in Cognito and configures both the API and
the React application to use the new client.

```yaml
service: example-2
frameworkVersion: '2'
provider:
  name: aws
  stage: dev
  runtime: nodejs14.x
  lambdaHashingVersion: 20201221
  httpApi:
    authorizers:
      cognito:
        type: jwt
        identitySource: $request.header.Authorization
        issuerUrl: https://cognito-idp.${aws:region}.amazonaws.com/${self:custom.userPoolId}
        audience:
          - !Ref SPAClient
functions:
  hello:
    handler: handler.hello
    events:
      - httpApi:
          method: 'GET'
          path: '/api'
          authorizer:
            name: cognito
            scopes:
              - profile
custom:
  userPoolId: ZZZZ
  CloudfrontReactPlugin:
    domainName: ${self:service}-${sls:stage}.example.com
    hostedZoneId: XXXX
    craDirectory: ../react-app
    certificateArn: arn:aws:acm:us-east-1:YYYY
    REACT_APP:
      NAME: ${self:service}-${sls:stage}
      CLIENT_ID:
        output: SPAClientID
      SERVICE_URL: https://cognito-idp.${aws:region}.amazonaws.com/${self:custom.userPoolId}
      API_URL:
        output: ServiceEndpoint
resources:
  Resources:
    SPAClient:
      Type: AWS::Cognito::UserPoolClient
      Properties:
        AccessTokenValidity: 60
        AllowedOAuthFlows:
          - code
        AllowedOAuthFlowsUserPoolClient: true
        AllowedOAuthScopes:
          - openid
          - profile
        CallbackURLs:
          - https://${self:custom.CloudfrontReactPlugin.domainName}/callback
        ClientName: ${self:service}-${sls:stage}
        EnableTokenRevocation: false
        ExplicitAuthFlows:
          - ALLOW_REFRESH_TOKEN_AUTH
        GenerateSecret: false
        IdTokenValidity: 2
        LogoutURLs:
          - https://${self:custom.CloudfrontReactPlugin.domainName}/
        PreventUserExistenceErrors: ENABLED
        RefreshTokenValidity: 2
        SupportedIdentityProviders:
          - COGNITO
        TokenValidityUnits:
          AccessToken: minutes
          IdToken: hours
          RefreshToken: days
        UserPoolId: ${self:custom.userPoolId}
  Outputs:
    SPAClientID:
      Value: !Ref SPAClient
```

When `sls deploy react` is executed, it will build the React app with
the environment variable `REACT_APP_CLIENT_ID` configured correctly, also the
authorizer is configured with the same id in the audience.

## Other bits

Copyright 2022, Karim Kanso. All rights reserved. Work licensed under GPLv3.
