import { useCallback, useEffect, useMemo, useState } from 'react';
import * as anchor from '@project-serum/anchor';

import styled from 'styled-components';
import { Container, Snackbar } from '@material-ui/core';
import Paper from '@material-ui/core/Paper';
import Alert from '@material-ui/lab/Alert';
import Grid from '@material-ui/core/Grid';
import Typography from '@material-ui/core/Typography';
import Box from '@material-ui/core/Box';
import Button from '@material-ui/core/Button';

import { useTheme } from '@material-ui/core/styles';
import useMediaQuery from '@material-ui/core/useMediaQuery';

import {
  Commitment,
  Connection,
  PublicKey,
  Transaction,
} from '@solana/web3.js';
import { useWallet } from '@solana/wallet-adapter-react';
import { WalletDialogButton } from '@solana/wallet-adapter-material-ui';
import {
  awaitTransactionSignatureConfirmation,
  CANDY_MACHINE_PROGRAM,
  CandyMachineAccount,
  createAccountsForMint,
  getCandyMachineState,
  getCollectionPDA,
  mintOneToken,
  SetupState,
} from './candy-machine';
import { AlertState, formatNumber, getAtaForMint, toDate } from './utils';
import { MintCountdown } from './MintCountdown';
import { MintButton } from './MintButton';
import { GatewayProvider } from '@civic/solana-gateway-react';
import { sendTransaction } from './connection';
import { WalletAdapterNetwork } from '@solana/wallet-adapter-base';

const ConnectButton = styled(WalletDialogButton)`
  width: 100%;
  margin-top: 32px;
  background: #71338c;
  color: white;
  font-size: 16px;
  font-weight: bold;
`;

const MintContainer = styled.div``; // add your owns styles here

export interface HomeProps {
  candyMachineId?: anchor.web3.PublicKey;
  connection: anchor.web3.Connection;
  txTimeout: number;
  rpcHost: string;
  network: WalletAdapterNetwork;
}

const Home = (props: HomeProps) => {
  const theme = useTheme();
  const matches = useMediaQuery(theme.breakpoints.down("sm"));

  const [isUserMinting, setIsUserMinting] = useState(false);
  const [candyMachine, setCandyMachine] = useState<CandyMachineAccount>();
  const [alertState, setAlertState] = useState<AlertState>({
    open: false,
    message: '',
    severity: undefined,
  });
  const [isActive, setIsActive] = useState(false);
  const [endDate, setEndDate] = useState<Date>();
  const [itemsRemaining, setItemsRemaining] = useState<number>();
  const [isWhitelistUser, setIsWhitelistUser] = useState(false);
  const [isPresale, setIsPresale] = useState(false);
  const [isValidBalance, setIsValidBalance] = useState(false);
  const [discountPrice, setDiscountPrice] = useState<anchor.BN>();
  const [needTxnSplit, setNeedTxnSplit] = useState(true);
  const [setupTxn, setSetupTxn] = useState<SetupState>();

  const rpcUrl = props.rpcHost;
  const wallet = useWallet();

  const anchorWallet = useMemo(() => {
    if (
      !wallet ||
      !wallet.publicKey ||
      !wallet.signAllTransactions ||
      !wallet.signTransaction
    ) {
      return;
    }

    return {
      publicKey: wallet.publicKey,
      signAllTransactions: wallet.signAllTransactions,
      signTransaction: wallet.signTransaction,
    } as anchor.Wallet;
  }, [wallet]);

  const refreshCandyMachineState = useCallback(
    async (commitment: Commitment = 'confirmed') => {
      if (!anchorWallet) {
        return;
      }

      const connection = new Connection(props.rpcHost, commitment);

      if (props.candyMachineId) {
        try {
          const cndy = await getCandyMachineState(
            anchorWallet,
            props.candyMachineId,
            connection,
          );

          let active =
            cndy?.state.goLiveDate?.toNumber() < new Date().getTime() / 1000;
          let presale = false;

          // duplication of state to make sure we have the right values!
          let isWLUser = false;
          let userPrice = cndy.state.price;

          // whitelist mint?
          if (cndy?.state.whitelistMintSettings) {
            // is it a presale mint?
            if (
              cndy.state.whitelistMintSettings.presale &&
              (!cndy.state.goLiveDate ||
                cndy.state.goLiveDate.toNumber() > new Date().getTime() / 1000)
            ) {
              presale = true;
            }
            // is there a discount?
            if (cndy.state.whitelistMintSettings.discountPrice) {
              setDiscountPrice(cndy.state.whitelistMintSettings.discountPrice);
              userPrice = cndy.state.whitelistMintSettings.discountPrice;
            } else {
              setDiscountPrice(undefined);
              // when presale=false and discountPrice=null, mint is restricted
              // to whitelist users only
              if (!cndy.state.whitelistMintSettings.presale) {
                cndy.state.isWhitelistOnly = true;
              }
            }
            // retrieves the whitelist token
            const mint = new anchor.web3.PublicKey(
              cndy.state.whitelistMintSettings.mint,
            );
            const token = (
              await getAtaForMint(mint, anchorWallet.publicKey)
            )[0];

            try {
              const balance = await connection.getTokenAccountBalance(token);
              isWLUser = parseInt(balance.value.amount) > 0;
              // only whitelist the user if the balance > 0
              setIsWhitelistUser(isWLUser);

              if (cndy.state.isWhitelistOnly) {
                active = isWLUser && (presale || active);
              }
            } catch (e) {
              setIsWhitelistUser(false);
              // no whitelist user, no mint
              if (cndy.state.isWhitelistOnly) {
                active = false;
              }
              console.log(
                'There was a problem fetching whitelist token balance',
              );
              console.log(e);
            }
          }
          userPrice = isWLUser ? userPrice : cndy.state.price;

          if (cndy?.state.tokenMint) {
            // retrieves the SPL token
            const mint = new anchor.web3.PublicKey(cndy.state.tokenMint);
            const token = (
              await getAtaForMint(mint, anchorWallet.publicKey)
            )[0];
            try {
              const balance = await connection.getTokenAccountBalance(token);

              const valid = new anchor.BN(balance.value.amount).gte(userPrice);

              // only allow user to mint if token balance >  the user if the balance > 0
              setIsValidBalance(valid);
              active = active && valid;
            } catch (e) {
              setIsValidBalance(false);
              active = false;
              // no whitelist user, no mint
              console.log('There was a problem fetching SPL token balance');
              console.log(e);
            }
          } else {
            const balance = new anchor.BN(
              await connection.getBalance(anchorWallet.publicKey),
            );
            const valid = balance.gte(userPrice);
            setIsValidBalance(valid);
            active = active && valid;
          }

          // datetime to stop the mint?
          if (cndy?.state.endSettings?.endSettingType.date) {
            setEndDate(toDate(cndy.state.endSettings.number));
            if (
              cndy.state.endSettings.number.toNumber() <
              new Date().getTime() / 1000
            ) {
              active = false;
            }
          }
          // amount to stop the mint?
          if (cndy?.state.endSettings?.endSettingType.amount) {
            let limit = Math.min(
              cndy.state.endSettings.number.toNumber(),
              cndy.state.itemsAvailable,
            );

            if (cndy.state.itemsRedeemed < limit) {
              setItemsRemaining(limit - cndy.state.itemsRedeemed);
            } else {
              setItemsRemaining(0);
              cndy.state.isSoldOut = true;
            }
          } else {
            setItemsRemaining(cndy.state.itemsRemaining);
          }

          if (cndy.state.isSoldOut) {
            active = false;
          }

          const [collectionPDA] = await getCollectionPDA(props.candyMachineId);
          const collectionPDAAccount = await connection.getAccountInfo(
            collectionPDA,
          );

          setIsActive((cndy.state.isActive = active));
          setIsPresale((cndy.state.isPresale = presale));
          setCandyMachine(cndy);

          const txnEstimate =
            892 +
            (!!collectionPDAAccount && cndy.state.retainAuthority ? 182 : 0) +
            (cndy.state.tokenMint ? 66 : 0) +
            (cndy.state.whitelistMintSettings ? 34 : 0) +
            (cndy.state.whitelistMintSettings?.mode?.burnEveryTime ? 34 : 0) +
            (cndy.state.gatekeeper ? 33 : 0) +
            (cndy.state.gatekeeper?.expireOnUse ? 66 : 0);

          setNeedTxnSplit(txnEstimate > 1230);
        } catch (e) {
          if (e instanceof Error) {
            if (
              e.message === `Account does not exist ${props.candyMachineId}`
            ) {
              setAlertState({
                open: true,
                message: `Couldn't fetch candy machine state from candy machine with address: ${props.candyMachineId}, using rpc: ${props.rpcHost}! You probably typed the REACT_APP_CANDY_MACHINE_ID value in wrong in your .env file, or you are using the wrong RPC!`,
                severity: 'error',
                hideDuration: null,
              });
            } else if (
              e.message.startsWith('failed to get info about account')
            ) {
              setAlertState({
                open: true,
                message: `Couldn't fetch candy machine state with rpc: ${props.rpcHost}! This probably means you have an issue with the REACT_APP_SOLANA_RPC_HOST value in your .env file, or you are not using a custom RPC!`,
                severity: 'error',
                hideDuration: null,
              });
            }
          } else {
            setAlertState({
              open: true,
              message: `${e}`,
              severity: 'error',
              hideDuration: null,
            });
          }
          console.log(e);
        }
      } else {
        setAlertState({
          open: true,
          message: `Your REACT_APP_CANDY_MACHINE_ID value in the .env file doesn't look right! Make sure you enter it in as plain base-58 address!`,
          severity: 'error',
          hideDuration: null,
        });
      }
    },
    [anchorWallet, props.candyMachineId, props.rpcHost],
  );

  const onMint = async (
    beforeTransactions: Transaction[] = [],
    afterTransactions: Transaction[] = [],
  ) => {
    try {
      setIsUserMinting(true);
      document.getElementById('#identity')?.click();
      if (wallet.connected && candyMachine?.program && wallet.publicKey) {
        let setupMint: SetupState | undefined;
        if (needTxnSplit && setupTxn === undefined) {
          setAlertState({
            open: true,
            message: 'Please sign account setup transaction',
            severity: 'info',
          });
          setupMint = await createAccountsForMint(
            candyMachine,
            wallet.publicKey,
          );
          let status: any = { err: true };
          if (setupMint.transaction) {
            status = await awaitTransactionSignatureConfirmation(
              setupMint.transaction,
              props.txTimeout,
              props.connection,
              true,
            );
          }
          if (status && !status.err) {
            setSetupTxn(setupMint);
            setAlertState({
              open: true,
              message:
                'Setup transaction succeeded! Please sign minting transaction',
              severity: 'info',
            });
          } else {
            setAlertState({
              open: true,
              message: 'Mint failed! Please try again!',
              severity: 'error',
            });
            setIsUserMinting(false);
            return;
          }
        } else {
          setAlertState({
            open: true,
            message: 'Please sign minting transaction',
            severity: 'info',
          });
        }

        let mintResult = await mintOneToken(
          candyMachine,
          wallet.publicKey,
          beforeTransactions,
          afterTransactions,
          setupMint ?? setupTxn,
        );

        let status: any = { err: true };
        let metadataStatus = null;
        if (mintResult) {
          status = await awaitTransactionSignatureConfirmation(
            mintResult.mintTxId,
            props.txTimeout,
            props.connection,
            true,
          );

          metadataStatus =
            await candyMachine.program.provider.connection.getAccountInfo(
              mintResult.metadataKey,
              'processed',
            );
          console.log('Metadata status: ', !!metadataStatus);
        }

        if (status && !status.err && metadataStatus) {
          // manual update since the refresh might not detect
          // the change immediately
          let remaining = itemsRemaining! - 1;
          setItemsRemaining(remaining);
          setIsActive((candyMachine.state.isActive = remaining > 0));
          candyMachine.state.isSoldOut = remaining === 0;
          setSetupTxn(undefined);
          setAlertState({
            open: true,
            message: 'Congratulations! Mint succeeded!',
            severity: 'success',
            hideDuration: 7000,
          });
          refreshCandyMachineState('processed');
        } else if (status && !status.err) {
          setAlertState({
            open: true,
            message:
              'Mint likely failed! Anti-bot SOL 0.01 fee potentially charged! Check the explorer to confirm the mint failed and if so, make sure you are eligible to mint before trying again.',
            severity: 'error',
            hideDuration: 8000,
          });
          refreshCandyMachineState();
        } else {
          setAlertState({
            open: true,
            message: 'Mint failed! Please try again!',
            severity: 'error',
          });
          refreshCandyMachineState();
        }
      }
    } catch (error: any) {
      let message = error.msg || 'Minting failed! Please try again!';
      if (!error.msg) {
        if (!error.message) {
          message = 'Transaction timeout! Please try again.';
        } else if (error.message.indexOf('0x137')) {
          console.log(error);
          message = `SOLD OUT!`;
        } else if (error.message.indexOf('0x135')) {
          message = `Insufficient funds to mint. Please fund your wallet.`;
        }
      } else {
        if (error.code === 311) {
          console.log(error);
          message = `SOLD OUT!`;
          window.location.reload();
        } else if (error.code === 312) {
          message = `Minting period hasn't started yet.`;
        }
      }

      setAlertState({
        open: true,
        message,
        severity: 'error',
      });
      // updates the candy machine state to reflect the latest
      // information on chain
      refreshCandyMachineState();
    } finally {
      setIsUserMinting(false);
    }
  };

  const toggleMintButton = () => {
    let active = !isActive || isPresale;

    if (active) {
      if (candyMachine!.state.isWhitelistOnly && !isWhitelistUser) {
        active = false;
      }
      if (endDate && Date.now() >= endDate.getTime()) {
        active = false;
      }
    }

    if (
      isPresale &&
      candyMachine!.state.goLiveDate &&
      candyMachine!.state.goLiveDate.toNumber() <= new Date().getTime() / 1000
    ) {
      setIsPresale((candyMachine!.state.isPresale = false));
    }

    setIsActive((candyMachine!.state.isActive = active));
  };

  useEffect(() => {
    refreshCandyMachineState();
  }, [
    anchorWallet,
    props.candyMachineId,
    props.connection,
    refreshCandyMachineState,
  ]);

  useEffect(() => {
    (function loop() {
      setTimeout(() => {
        refreshCandyMachineState();
        loop();
      }, 20000);
    })();
  }, [refreshCandyMachineState]);

  return (
    <>
      <Box style={{ backgroundColor: '#3d3270' }}>
        {
          matches ? (
            <>
              <Box sx={{ display: 'flex', justifyContent: 'center' }}>
                <Box style={{ padding: '12px 0px' }}>
                  <img src={"head_logo.png"} width='28px' />
                </Box>
                <Box style={{ padding: '4px 12px', }}>
                  <Typography style={{ color: 'white', fontFamily: 'AMSTERDAM', fontSize: '26px' }}>CHIMP BASTARDS</Typography>
                </Box>
              </Box>
            </>
          ) : (
            <>
              <Container style={{ maxWidth: '1329px', padding: '0px' }}>
                <Box sx={{ display: 'flex', justifyContent: 'space-between' }}>
                  <Box sx={{ display: 'flex', justifyContent: 'flex-start' }}>
                    <Box style={{ padding: '16px 12px' }}>
                      <img src={"head_logo.png"} />
                    </Box>
                    <Box style={{ padding: '12px 12px', }}>
                      <Button style={{ color: 'white', fontFamily: 'AMSTERDAM', fontSize: '34px' }}>HOME</Button>
                    </Box>
                    <Box style={{ padding: '12px 12px', }}>
                      <Button style={{ color: 'white', fontFamily: 'AMSTERDAM', fontSize: '34px' }}>MINTING</Button>
                    </Box>
                    <Box style={{ padding: '12px 12px', }}>
                      <Button style={{ color: 'white', fontFamily: 'AMSTERDAM', fontSize: '34px' }}>STAKING</Button>
                    </Box>
                    <Box style={{ padding: '12px 12px', }}>
                      <Button style={{ color: 'white', fontFamily: 'AMSTERDAM', fontSize: '34px' }}>MARKETPLACE</Button>
                    </Box>
                    <Box style={{ padding: '12px 12px', }}>
                      <Button style={{ color: '#ffba00', fontFamily: 'AMSTERDAM', fontSize: '34px' }}>GEN 0</Button>
                    </Box>
                  </Box>
                  <Box>
                    {!wallet.connected ? (
                      <ConnectButton>Connect Wallet</ConnectButton>
                    ) : (
                      <></>
                    )}
                  </Box>
                </Box>
              </Container>
            </>
          )
        }
      </Box >

      {
        matches ? (
          <>
            <Box style={{ textAlign: 'center' }}>
              {!wallet.connected ? (
                <ConnectButton style={{ width: '70%', margin: '10px 0px' }}>Connect Wallet</ConnectButton>
              ) : (
                <></>
              )}
            </Box>
          </>
        ) : (
          <></>
        )
      }

      <Box style={{
        backgroundImage: matches ? "url(main_bg_mobile.png)" : "url(main_bg.png)",
        backgroundPosition: 'center',
        backgroundSize: 'cover',
        backgroundRepeat: 'no-repeat',
        minHeight: matches ? '648px' : '936px',
      }}>
        <Container style={{ maxWidth: matches ? '336px' : '1329px', paddingTop: matches ? '' : '434px' }}>
          {
            matches ? (
              <>
                <Box sx={{ display: 'flex', justifyContent: 'space-between', pt: 5 }}>
                  <Box style={{ textAlign: 'left' }}>
                    <Typography style={{ color: 'white', fontFamily: 'SPRAY LETTERS', fontSize: matches ? '16px' : '28px' }}>REMAINING TIME</Typography>
                    <Typography style={{ color: '#ffba00', fontFamily: 'AMSTERDAM', fontSize: matches ? '42px' : '64px', lineHeight: '100%' }}>00:00:00</Typography>
                  </Box>
                  <Box style={{ textAlign: 'right' }}>
                    <Typography style={{ color: 'white', fontFamily: 'SPRAY LETTERS', fontSize: matches ? '16px' : '28px' }}>MINTED NFTS</Typography>
                    <Typography style={{ color: '#ffba00', fontFamily: 'AMSTERDAM', fontSize: matches ? '42px' : '64px', lineHeight: '100%' }}>{candyMachine && (`${candyMachine.state.itemsRedeemed} / ${candyMachine.state.itemsAvailable}`)}</Typography>
                  </Box>
                </Box>
              </>
            ) : (
              <>
                <Box sx={{ display: 'flex', justifyContent: 'space-between' }}>
                  <Box style={{ textAlign: 'center' }}>
                    <Typography style={{ color: 'white', fontFamily: 'SPRAY LETTERS', fontSize: '28px' }}>MINTED NFTS</Typography>
                    <Typography style={{ color: '#ffba00', fontFamily: 'AMSTERDAM', fontSize: '64px', lineHeight: '100%' }}>{candyMachine && (`${candyMachine.state.itemsRedeemed} / ${candyMachine.state.itemsAvailable}`)}</Typography>
                  </Box>
                  <Box></Box>
                  <Box style={{ textAlign: 'center' }}>
                    <Typography style={{ color: 'white', fontFamily: 'SPRAY LETTERS', fontSize: '28px' }}>MINT PRICE</Typography>
                    <Typography style={{ color: '#ffba00', fontFamily: 'AMSTERDAM', fontSize: '64px', lineHeight: '100%' }}>
                      {candyMachine && (
                        <>
                          {
                            isWhitelistUser && discountPrice
                              ? `${formatNumber.asNumber(discountPrice)}$SOL`
                              : `${formatNumber.asNumber(candyMachine.state.price)}$SOL`
                          }
                        </>
                      )}
                    </Typography>
                    <Typography style={{ color: 'white', fontSize: '20px' }}>Excluding GAS FEES</Typography>

                    <MintButton
                      candyMachine={candyMachine}
                      isMinting={isUserMinting}
                      setIsMinting={val => setIsUserMinting(val)}
                      onMint={onMint}
                      isActive={
                        isActive ||
                        (isPresale && isWhitelistUser && isValidBalance)
                      }
                    />
                  </Box>
                </Box>
              </>
            )
          }
        </Container>
      </Box>

      <Box style={{ background: '#172334' }} sx={{ pt: 5, pb: 5 }}>
        <Container style={{ maxWidth: matches ? '336px' : '1329px', padding: '0px' }}>
          <Snackbar
            open={alertState.open}
            autoHideDuration={
              alertState.hideDuration === undefined ? 6000 : alertState.hideDuration
            }
            onClose={() => setAlertState({ ...alertState, open: false })}
          >
            <Alert
              onClose={() => setAlertState({ ...alertState, open: false })}
              severity={alertState.severity}
            >
              {alertState.message}
            </Alert>
          </Snackbar>
          <Box>
            <Box sx={{ display: 'flex', flexDirection: matches ? 'column' : 'row' }} style={{ textAlign: matches ? 'center' : 'left' }}>
              <Typography style={{ color: 'white', fontSize: '20px' }}>CHIMP BASTARDS GEN 0 MINT:</Typography>
              <Typography style={{ color: '#ffba00', fontFamily: 'AMSTERDAM', fontSize: '50px', lineHeight: '30%' }}>TROOP PASS!</Typography>
            </Box>

            <Grid container>
              <Grid item md={6} sm={6} xs={12}>
                <Box sx={{ pr: matches ? 0 : 5 }}>
                  <Box sx={{ mt: 3 }}>
                    <Typography style={{ color: 'white', fontSize: '16px' }}>Before we launch our main collection, we will be putting out a Gen 0 collection first. The Gen 0 mint will consist of 555 Troop Passes. All of which will be packed with utilities. Among the utilities will include but will not be limited to the following:</Typography>
                  </Box>
                  <Box sx={{ mt: 3 }}>
                    <Typography style={{ color: 'white', fontSize: '16px' }}>-Holders of Gen 0 will be airdropped one (1) NFT from the main collection, Chimp Bastards(CB), for free!</Typography>
                  </Box>
                  <Box sx={{ mt: 3 }}>
                    <Typography style={{ color: 'white', fontSize: '16px' }}>-Holders will receive one (1) free airdrop for subsequent collections within the Chimp Bastards ecosystem</Typography>
                  </Box>
                  <Box sx={{ mt: 3 }}>
                    <Typography style={{ color: 'white', fontSize: '16px' }}>-Holders will have first dibs on hte allocations on our first Chimpvestment deal. This means that they will get a free allocation of the first deal that CB will be investing in.</Typography>
                  </Box>
                </Box>
              </Grid>
              <Grid item md={6} sm={6} xs={12}>
                <Box style={{ display: matches ? 'none' : '' }}>
                  <Box sx={{ mt: 3 }}>
                    <Typography style={{ color: '#352e63', fontSize: '16px' }}>-Holders will have an exclusive role which will have special privileges within the community</Typography>
                  </Box>
                  <Box sx={{ mt: 3 }}>
                    <Typography style={{ color: '#352e63', fontSize: '16px' }}>-Holders will get priority to receive a CB merch</Typography>
                  </Box>
                  <Box sx={{ mt: 3 }}>
                    <Typography style={{ color: '#352e63', fontSize: '16px' }}>-The troop pass will have special interactions with your CB NFT</Typography>
                  </Box>
                  <Box sx={{ mt: 3 }}>
                    <Typography style={{ color: '#352e63', fontSize: '16px' }}>-Exclusive access to the Chimp Elite Club in discord, an exclusive club which gets access to the most sought-after cross chain alphas.</Typography>
                  </Box>
                  <Box sx={{ mt: 3 }}>
                    <Typography style={{ color: '#352e63', fontSize: '16px' }}>-Add The Chimp Elite Club will get 20% revenue sharing from the mint proceeds of the main mint and 20% revenue share for the royalities of the main mint, which will be divided among its members on a monthly basis.</Typography>
                  </Box>
                </Box>
              </Grid>
            </Grid>
          </Box>
        </Container>
      </Box>
    </>
  );
};

const getCountdownDate = (
  candyMachine: CandyMachineAccount,
): Date | undefined => {
  if (
    candyMachine.state.isActive &&
    candyMachine.state.endSettings?.endSettingType.date
  ) {
    return toDate(candyMachine.state.endSettings.number);
  }

  return toDate(
    candyMachine.state.goLiveDate
      ? candyMachine.state.goLiveDate
      : candyMachine.state.isPresale
        ? new anchor.BN(new Date().getTime() / 1000)
        : undefined,
  );
};

export default Home;
