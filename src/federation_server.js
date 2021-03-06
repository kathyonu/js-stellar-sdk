import axios from 'axios';
import URI from 'urijs';
import Promise from 'bluebird';
import toml from 'toml';
import {isString, pick} from "lodash";
import {Account} from 'stellar-base';

export class FederationServer {
  /**
   * FederationServer handles a network connection to a
   * [federation server](https://www.stellar.org/developers/learn/concepts/federation.html)
   * instance and exposes an interface for requests to that instance.
   * @constructor
   * @param {string} serverURL The federation server URL (ex. `https://acme.com/federation`). The old method (config object parameter) is **deprecated**.
   * @param {string} domain Domain this server represents
   */
  constructor(serverURL, domain) {
    if (isString(serverURL)) {
      // TODO `domain` regexp
      this.serverURL = URI(serverURL);
      this.domain = domain;
    } else {
      // We leave the old method for compatibility reasons.
      // This will be removed in the next major release.
      if (!serverURL) {
        serverURL = {};
      }
      this.protocol = serverURL.secure ? "https" : "http";
      this.hostname = serverURL.hostname || "localhost";
      this.port = serverURL.port || 80;
      this.path = serverURL.path || '/federation';
      this.domain = serverURL.domain;
      this.serverURL = URI({
        protocol: this.protocol,
        hostname: this.hostname,
        port: this.port,
        path: this.path
      });
    }
  }

  /**
   * This method is a helper method for handling user inputs that contain `destination` value.
   * It accepts two types of values:
   *
   * * For Stellar address (ex. `bob*stellar.org`) it splits Stellar address and then tries to find information about
   * federation server in `stellar.toml` file for a given domain. It returns a `Promise` which resolves if federation
   * server exists and user has been found and rejects in all other cases.
   * * For Account ID (ex. `GB5XVAABEQMY63WTHDQ5RXADGYF345VWMNPTN2GFUDZT57D57ZQTJ7PS`) it returns a `Promise` which
   * resolves if Account ID is valid and rejects in all other cases. Please note that this method does not check
   * if the account actually exists in a ledger.
   *
   * Example:
   * ```js
   * StellarSdk.FederationServer.forAddress('bob*stellar.org')
   *  .then(federationRecord => {
   *    // {
   *    //   account_id: 'GB5XVAABEQMY63WTHDQ5RXADGYF345VWMNPTN2GFUDZT57D57ZQTJ7PS',
   *    //   memo_type: 'id',
   *    //   memo: 100
   *    // }
   *  });
   * ```
   * It returns a `Promise` that will resolve to a JSON object with following fields:
   * * `account_id` - Account ID of the destination,
   * * `memo_type` (optional) - Memo type that needs to be attached to a transaction,
   * * `memo` (optional) - Memo value that needs to be attached to a transaction.
   *
   * The Promise will reject in case of any errors.
   *
   * @see <a href="https://www.stellar.org/developers/learn/concepts/federation.html" target="_blank">Federation doc</a>
   * @see <a href="https://www.stellar.org/developers/learn/concepts/stellar-toml.html" target="_blank">Stellar.toml doc</a>
   * @param {string} value Stellar Address (ex. `bob*stellar.org`)
   * @returns {Promise}
   */
  static resolve(value) {
    // Check if `value` is in account ID format
    if (value.indexOf('*') < 0) {
      if (!Account.isValidAccountId(value)) {
        return Promise.reject(new Error('Invalid Account ID'));
      } else {
        return Promise.resolve({account_id: value});
      }
    } else {
      let addressParts = value.split('*');
      let [,domain] = addressParts;

      if (addressParts.length != 2 || !domain) {
        return Promise.reject(new Error('Invalid Stellar address'));
      }
      return FederationServer.createForDomain(domain)
        .then(federationServer => federationServer.resolveAddress(value))
        .then(response => pick(response, ['account_id', 'memo_type', 'memo']));
    }
  }

  /**
   * Creates a `FederationServer` instance based on information from [stellar.toml](https://www.stellar.org/developers/learn/concepts/stellar-toml.html) file for a given domain.
   * Returns a `Promise` that resolves to a `FederationServer` object. If `stellar.toml` file does not exist for a given domain or it does not contain information about a federation server Promise will reject.
   * ```js
   * StellarSdk.FederationServer.createForDomain('acme.com')
   *   .then(federationServer => {
   *     // federationServer.forAddress('bob').then(...)
   *   })
   *   .catch(error => {
   *     // stellar.toml does not exist or it does not contain information about federation server.
   *   });
   * ```
   * @see <a href="https://www.stellar.org/developers/learn/concepts/stellar-toml.html" target="_blank">Stellar.toml doc</a>
   * @param {string} domain Domain to get federation server for
   * @returns {Promise}
   */
  static createForDomain(domain) {
    return axios.get(`https://www.${domain}/.well-known/stellar.toml`)
      .then(response => {
        let tomlObject = toml.parse(response.data);
        if (!tomlObject.FEDERATION_SERVER) {
          return Promise.reject(new Error('stellar.toml does not contain FEDERATION_SERVER field'));
        }
        return new FederationServer(tomlObject.FEDERATION_SERVER, domain);
      });
  }

  /**
   * Returns a Promise that resolves to federation record if the user was found for a given Stellar address.
   * @see <a href="https://www.stellar.org/developers/learn/concepts/federation.html" target="_blank">Federation doc</a>
   * @param {string} address Stellar address (ex. `bob*stellar.org`). If `FederationServer` was instantiated with `domain` param only username (ex. `bob`) can be passed.
   * @returns {Promise}
   */
  resolveAddress(address) {
    if (address.indexOf('*') < 0) {
      if (!this.domain) {
        return Promise.reject(new Error('Unknown domain. Make sure `address` contains a domain (ex. `bob*stellar.org`) or pass `domain` parameter when instantiating the server object.'));
      }
      address = `${address}*${this.domain}`;
    }
    let url = this.serverURL.query({type: 'name', q: address});
    return this._sendRequest(url);
  }

  /**
   * Returns a Promise that resolves to federation record if the user was found for a given account ID.
   * @see <a href="https://www.stellar.org/developers/learn/concepts/federation.html" target="_blank">Federation doc</a>
   * @param {string} accountId Account ID (ex. `GBYNR2QJXLBCBTRN44MRORCMI4YO7FZPFBCNOKTOBCAAFC7KC3LNPRYS`)
   * @returns {Promise}
   */
  resolveAccountId(accountId) {
    let url = this.serverURL.query({type: 'id', q: accountId});
    return this._sendRequest(url);
  }

  /**
   * Returns a Promise that resolves to federation record if the sender of the transaction was found for a given transaction ID.
   * @see <a href="https://www.stellar.org/developers/learn/concepts/federation.html" target="_blank">Federation doc</a>
   * @param {string} transactionId Transaction ID (ex. `3389e9f0f1a65f19736cacf544c2e825313e8447f569233bb8db39aa607c8889`)
   * @returns {Promise}
   */
  resolveTransactionId(transactionId) {
    let url = this.serverURL.query({type: 'txid', q: transactionId});
    return this._sendRequest(url);
  }

  _sendRequest(url) {
    return axios.get(url.toString())
      .then(response => response.data)
      .catch(function (response) {
        if (response instanceof Error) {
          return Promise.reject(response);
        } else {
          return Promise.reject(response.data);
        }
      });
  }
}
